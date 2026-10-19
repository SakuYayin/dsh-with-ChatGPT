// End-to-end tests for lib/oauth.js and lib/pairing.js.
//
// The auth server is exercised over a real node:http server bound to 127.0.0.1
// (global fetch as the browser/ChatGPT stand-in), and PairingManager is driven
// directly for the code lifecycle unit tests. No network beyond loopback, no
// filesystem outside a temp directory, no npm dependencies.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AuthServer } from '../lib/oauth.js';
import { PairingManager } from '../lib/pairing.js';
import { StateStore } from '../lib/state.js';
import { randomToken, sendJson, sleep } from '../lib/util.js';

const PREFIX = 'dsh-with-chatgpt';
const RESOURCE = `${PREFIX}/mcp`;
const ALPHABET_CLASS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Inert logger: tests must not print plugin diagnostics. */
function quietLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/** A throwaway StateStore rooted in the OS temp directory. */
async function makeStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-with-chatgpt-auth-'));
  const store = new StateStore(root);
  await store.init();
  return { root, store, async dispose() { await rm(root, { recursive: true, force: true }); } };
}

const WELL_KNOWN_PREFIXES = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
];

/**
 * Route one request exactly like lib/http.js does: the caller hands over a parsed
 * URL whose pathname is already stripped of the bridge prefix, plus the origin.
 */
async function route(auth, req, res) {
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
  const url = new URL(req.url ?? '/', origin);
  const pathname = url.pathname;
  const isWellKnown = WELL_KNOWN_PREFIXES.some((base) => pathname === base || pathname.startsWith(`${base}/`));
  const relative = pathname.startsWith(`/${PREFIX}`) ? pathname.slice(PREFIX.length + 1) : pathname;
  // Metadata lives at the web-server root but the auth server renders it as if
  // it sat under the bridge prefix; every other route arrives already stripped.
  const target = isWellKnown ? `/${PREFIX}${pathname}${url.search}` : `${relative}${url.search}`;
  const handled = await auth.handle(req, res, { origin, url: new URL(target, url.origin), clientIp: '127.0.0.1' });
  if (!handled) sendJson(res, 404, { error: 'not_found' });
}

/** Boot a loopback bridge around a fresh AuthServer. */
async function startServer(options = {}) {
  const store = await makeStore();
  const auth = new AuthServer({
    store: store.store,
    config: {
      prefix: PREFIX,
      workspaceName: options.workspaceName ?? 'demo workspace',
      ...(options.config ?? {}),
    },
    log: quietLog(),
  });
  const server = http.createServer((req, res) => {
    route(auth, req, res).catch((error) => {
      if (res.headersSent) res.end();
      else sendJson(res, 500, { error: 'server_error', error_description: String(error?.message ?? error) });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    store: store.store,
    root: store.root,
    auth,
    base,
    redirectUri: `${base}/callback`,
    async close() {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
      await store.dispose();
    },
  };
}

/* ------------------------------------------------------------------ helpers --- */

function pkcePair() {
  const verifier = randomToken(32);
  const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery({ clientId, redirectUri, challenge, state = 'state-xyz', scope = '' }) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope,
  };
}

function extractCsrf(html) {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

async function registerClient(server, redirectUris, clientName = 'ChatGPT') {
  const response = await fetch(`${server.base}/${PREFIX}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: redirectUris }),
  });
  const body = await response.json();
  return { response, body, clientId: body.client_id };
}

async function openAuthorizePage(server, query) {
  const url = new URL(`${server.base}/${PREFIX}/authorize`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, { redirect: 'manual' });
  const html = await response.text();
  return { response, html, csrf: extractCsrf(html) };
}

async function submitAuthorize(server, fields) {
  return fetch(`${server.base}/${PREFIX}/authorize`, {
    method: 'POST',
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

async function postToken(server, fields) {
  const response = await fetch(`${server.base}/${PREFIX}/token`, {
    method: 'POST',
    body: new URLSearchParams(fields),
  });
  return { response, body: await response.json() };
}

async function exchangeCode(server, { code, clientId, redirectUri, verifier }) {
  return postToken(server, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

async function exchangeRefresh(server, { refreshToken, clientId }) {
  return postToken(server, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

/**
 * Walk the flow up to (but excluding) the pairing form submit:
 * DCR -> issue pairing code -> GET /authorize. Returns everything the next step needs.
 */
async function bootstrapAuthorization(server, overrides = {}) {
  const { clientId } = await registerClient(server, overrides.redirectUris ?? [server.redirectUri]);
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({
    clientId,
    redirectUri: overrides.redirectUri ?? server.redirectUri,
    challenge: overrides.challenge ?? challenge,
    state: overrides.state ?? 'state-xyz',
  });
  const issued = await server.auth.pairing.issue();
  const page = await openAuthorizePage(server, query);
  return { clientId, verifier, challenge, query, page, pairingCode: issued.code, csrf: page.csrf };
}

/* ------------------------------------------------------------- pairing unit --- */

test('pairing: issue formats XXXX-XXXX from an unambiguous alphabet', async () => {
  const store = await makeStore();
  try {
    const pairing = new PairingManager({ store: store.store });
    const issued = await pairing.issue();
    assert.match(issued.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(issued.code.length, 9);
    assert.equal(issued.code.indexOf('-'), 4);
    // 0/O/1/I/L must never be rendered: a human has to retype the code.
    assert.doesNotMatch(issued.code.replace('-', ''), /[01OIL]/);
    for (const char of issued.code.replace('-', '')) assert.ok(ALPHABET_CLASS.includes(char));
    assert.ok(Date.parse(issued.expiresAt) > Date.now());
    assert.equal(issued.ttlMs, 5 * 60 * 1000);

    const status = pairing.status();
    assert.equal(status.active, true);
    assert.equal(status.code, issued.code);
    assert.equal(status.attemptsLeft, 5);
    assert.equal(status.locked, false);
    assert.equal(store.store.state.pairing.code, issued.code.replace('-', ''));
  } finally {
    await store.dispose();
  }
});

test('pairing: a correct code is consumed exactly once and persisted', async () => {
  const store = await makeStore();
  try {
    const pairing = new PairingManager({ store: store.store });
    const issued = await pairing.issue();
    // Dashes, spaces and lowercase are forgiving: the human may retype it.
    const typed = issued.code.toLowerCase().replace('-', ' ');
    assert.deepEqual(await pairing.claim({ code: typed, ip: '10.0.0.1' }), { ok: true });
    assert.deepEqual(await pairing.claim({ code: issued.code, ip: '10.0.0.1' }), { ok: false, reason: 'CONSUMED' });
    assert.equal(pairing.status().active, false);

    // A fresh store on the same root sees the consumed code: state actually persisted.
    const reloaded = new StateStore(store.root);
    await reloaded.init();
    assert.equal(reloaded.state.pairing.consumed, true);
  } finally {
    await store.dispose();
  }
});

test('pairing: wrong guesses lock the code after maxAttempts', async () => {
  const store = await makeStore();
  try {
    const pairing = new PairingManager({ store: store.store, maxAttempts: 2 });
    const issued = await pairing.issue();
    const wrong = 'ZZZZ-ZZZZ';
    assert.deepEqual(await pairing.claim({ code: wrong, ip: '10.0.0.2' }), { ok: false, reason: 'INVALID' });
    assert.deepEqual(await pairing.claim({ code: wrong, ip: '10.0.0.2' }), { ok: false, reason: 'INVALID' });
    assert.deepEqual(await pairing.claim({ code: wrong, ip: '10.0.0.2' }), { ok: false, reason: 'LOCKED' });
    // Locked means locked: even the correct code no longer works.
    assert.deepEqual(await pairing.claim({ code: issued.code, ip: '10.0.0.2' }), { ok: false, reason: 'LOCKED' });
    assert.equal(pairing.status().locked, true);
    assert.equal(pairing.status().attemptsLeft, 0);
  } finally {
    await store.dispose();
  }
});

test('pairing: expired codes are rejected', async () => {
  const store = await makeStore();
  try {
    const pairing = new PairingManager({ store: store.store, ttlMs: 5 });
    const issued = await pairing.issue();
    await sleep(25);
    assert.deepEqual(await pairing.claim({ code: issued.code, ip: '10.0.0.3' }), { ok: false, reason: 'EXPIRED' });
    assert.equal(pairing.status().active, false);
  } finally {
    await store.dispose();
  }
});

test('pairing: failed claims are limited per IP inside the window', async () => {
  const store = await makeStore();
  try {
    const pairing = new PairingManager({ store: store.store, ipLimit: 2, maxAttempts: 5 });
    const issued = await pairing.issue();
    assert.deepEqual(await pairing.claim({ code: 'AAAA-AAAA', ip: '10.0.0.4' }), { ok: false, reason: 'INVALID' });
    assert.deepEqual(await pairing.claim({ code: 'BBBB-BBBB', ip: '10.0.0.4' }), { ok: false, reason: 'INVALID' });
    // The IP is locked now even with the right code...
    assert.deepEqual(await pairing.claim({ code: issued.code, ip: '10.0.0.4' }), { ok: false, reason: 'LOCKED' });
    // ...but another client IP is unaffected.
    assert.deepEqual(await pairing.claim({ code: issued.code, ip: '10.0.0.5' }), { ok: true });
  } finally {
    await store.dispose();
  }
});

test('pairing: revoke drops the code and every IP counter', async () => {
  const store = await makeStore();
  try {
    const pairing = new PairingManager({ store: store.store });
    const issued = await pairing.issue();
    assert.deepEqual(await pairing.revoke(), { ok: true });
    assert.equal(pairing.status().active, false);
    assert.equal(pairing.status().code, undefined);
    assert.deepEqual(await pairing.claim({ code: issued.code, ip: '10.0.0.6' }), { ok: false, reason: 'INVALID' });
  } finally {
    await store.dispose();
  }
});

/* --------------------------------------------------------------- discovery --- */

test('oauth: protected-resource and authorization-server metadata', async () => {
  const server = await startServer();
  try {
    const resource = await fetch(`${server.base}/.well-known/oauth-protected-resource`);
    assert.equal(resource.status, 200);
    assert.equal(resource.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await resource.json(), {
      resource: `${server.base}/${RESOURCE}`,
      authorization_servers: [server.base],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
    });

    // RFC 9728 path-suffixed form that ChatGPT probes after a 401.
    const nested = await fetch(`${server.base}/.well-known/oauth-protected-resource/${RESOURCE}`);
    assert.equal(nested.status, 200);
    assert.deepEqual(await nested.json(), await (await fetch(`${server.base}/.well-known/oauth-protected-resource`)).json());

    const metadata = await fetch(`${server.base}/.well-known/oauth-authorization-server`);
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await metadata.json(), {
      issuer: server.base,
      authorization_endpoint: `${server.base}/${PREFIX}/authorize`,
      token_endpoint: `${server.base}/${PREFIX}/token`,
      registration_endpoint: `${server.base}/${PREFIX}/register`,
      revocation_endpoint: `${server.base}/${PREFIX}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [],
    });
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------ registration --- */

test('oauth: dynamic client registration enforces https or loopback redirects', async () => {
  const server = await startServer();
  try {
    const insecure = await registerClient(server, ['http://chatgpt.example.com/callback']);
    assert.equal(insecure.response.status, 400);
    assert.equal(insecure.body.error, 'invalid_redirect_uri');

    const missing = await fetch(`${server.base}/${PREFIX}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT' }),
    });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, 'invalid_redirect_uri');

    const https = await registerClient(server, ['https://chatgpt.com/connector_platform_oauth_redirect']);
    assert.equal(https.response.status, 201);
    assert.equal(https.body.token_endpoint_auth_method, 'none');
    assert.deepEqual(https.body.redirect_uris, ['https://chatgpt.com/connector_platform_oauth_redirect']);

    const loopback = await registerClient(server, [server.redirectUri]);
    assert.equal(loopback.response.status, 201);
    assert.equal(server.auth.listClients().length, 2);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------ happy path --- */

test('oauth: full pairing + authorization-code + rotating-refresh flow', async () => {
  const server = await startServer({ workspaceName: 'dsh-with-chatgpt demo' });
  try {
    const flow = await bootstrapAuthorization(server);
    assert.equal(flow.page.response.status, 200);
    assert.match(flow.page.response.headers.get('content-type') ?? '', /text\/html/);
    assert.ok(flow.page.html.includes('dsh-with-chatgpt demo'));
    assert.ok(flow.csrf, 'the GET /authorize page must embed a CSRF token');
    assert.equal(server.auth.listClients().length, 1);

    const submitted = await submitAuthorize(server, {
      ...flow.query,
      csrf_token: flow.csrf,
      code: flow.pairingCode,
    });
    assert.equal(submitted.status, 302);
    assert.equal(submitted.headers.get('cache-control'), 'no-store');
    const location = new URL(submitted.headers.get('location'));
    assert.equal(location.pathname, '/callback');
    assert.ok(location.searchParams.get('code'), 'the redirect must carry an authorization code');
    assert.equal(location.searchParams.get('state'), 'state-xyz');
    const authorizationCode = location.searchParams.get('code');

    const granted = await exchangeCode(server, {
      code: authorizationCode,
      clientId: flow.clientId,
      redirectUri: server.redirectUri,
      verifier: flow.verifier,
    });
    assert.equal(granted.response.status, 200);
    assert.equal(granted.body.token_type, 'Bearer');
    assert.equal(granted.body.expires_in, 3600);
    assert.ok(granted.body.access_token);
    assert.ok(granted.body.refresh_token);
    assert.equal(server.auth.hasActiveTokens(), true);

    const accepted = await server.auth.authenticate(
      { headers: { authorization: `Bearer ${granted.body.access_token}` }, socket: {} },
      { origin: server.base },
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.clientId, flow.clientId);

    // A refresh token must never be usable as a bearer credential.
    const wrongKind = await server.auth.authenticate(
      { headers: { authorization: `Bearer ${granted.body.refresh_token}` }, socket: {} },
      { origin: server.base },
    );
    assert.equal(wrongKind.ok, false);
    assert.equal(wrongKind.status, 403);

    const rotated = await exchangeRefresh(server, {
      refreshToken: granted.body.refresh_token,
      clientId: flow.clientId,
    });
    assert.equal(rotated.response.status, 200);
    assert.notEqual(rotated.body.access_token, granted.body.access_token);
    assert.notEqual(rotated.body.refresh_token, granted.body.refresh_token);
    assert.equal(rotated.body.token_type, 'Bearer');

    const replay = await exchangeRefresh(server, {
      refreshToken: granted.body.refresh_token,
      clientId: flow.clientId,
    });
    assert.equal(replay.response.status, 400);
    assert.equal(replay.body.error, 'invalid_grant');
    assert.match(replay.body.error_description, /reuse|family/i);

    // Reuse of a rotated refresh token revokes the whole family: the access token
    // handed out by the rotation is dead too.
    const dead = await server.auth.authenticate(
      { headers: { authorization: `Bearer ${rotated.body.access_token}` }, socket: {} },
      { origin: server.base },
    );
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 401);
    assert.equal(server.auth.hasActiveTokens(), false);

    // RFC 7009: revocation answers 200 even for an unknown token.
    const revoked = await fetch(`${server.base}/${PREFIX}/revoke`, {
      method: 'POST',
      body: new URLSearchParams({ token: 'not-a-real-token' }),
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.headers.get('cache-control'), 'no-store');

    await server.auth.revokeAll();
    assert.deepEqual(server.auth.listClients(), []);
  } finally {
    await server.close();
  }
});

/* -------------------------------------------------------------- negative --- */

test('oauth: a wrong PKCE verifier is rejected at the token endpoint', async () => {
  const server = await startServer();
  try {
    const flow = await bootstrapAuthorization(server);
    const submitted = await submitAuthorize(server, {
      ...flow.query,
      csrf_token: flow.csrf,
      code: flow.pairingCode,
    });
    assert.equal(submitted.status, 302);
    const authorizationCode = new URL(submitted.headers.get('location')).searchParams.get('code');

    const rejected = await exchangeCode(server, {
      code: authorizationCode,
      clientId: flow.clientId,
      redirectUri: server.redirectUri,
      verifier: randomToken(32),
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, 'invalid_grant');
    assert.match(rejected.body.error_description, /PKCE/i);
  } finally {
    await server.close();
  }
});

test('oauth: an authorization code is single use', async () => {
  const server = await startServer();
  try {
    const flow = await bootstrapAuthorization(server);
    const submitted = await submitAuthorize(server, {
      ...flow.query,
      csrf_token: flow.csrf,
      code: flow.pairingCode,
    });
    const authorizationCode = new URL(submitted.headers.get('location')).searchParams.get('code');

    const first = await exchangeCode(server, {
      code: authorizationCode,
      clientId: flow.clientId,
      redirectUri: server.redirectUri,
      verifier: flow.verifier,
    });
    assert.equal(first.response.status, 200);

    const second = await exchangeCode(server, {
      code: authorizationCode,
      clientId: flow.clientId,
      redirectUri: server.redirectUri,
      verifier: flow.verifier,
    });
    assert.equal(second.response.status, 400);
    assert.equal(second.body.error, 'invalid_grant');
    assert.match(second.body.error_description, /already used/i);
  } finally {
    await server.close();
  }
});

test('oauth: plain PKCE is rejected and never redirects', async () => {
  const server = await startServer();
  try {
    const { clientId } = await registerClient(server, [server.redirectUri]);
    const { challenge } = pkcePair();
    const query = authorizeQuery({ clientId, redirectUri: server.redirectUri, challenge });

    const getRejected = await openAuthorizePage(server, { ...query, code_challenge_method: 'plain' });
    assert.equal(getRejected.response.status, 400);
    assert.equal(getRejected.response.headers.get('location'), null);
    assert.match(getRejected.html, /S256/);

    // A valid page supplies the CSRF token; the POST itself flips to plain.
    const valid = await openAuthorizePage(server, query);
    assert.ok(valid.csrf);
    const issued = await server.auth.pairing.issue();
    const postRejected = await submitAuthorize(server, {
      ...query,
      code_challenge_method: 'plain',
      csrf_token: valid.csrf,
      code: issued.code,
    });
    assert.equal(postRejected.status, 400);
    assert.equal(postRejected.headers.get('location'), null);
    const body = await postRejected.text();
    assert.match(body, /S256/);
    assert.equal(await server.auth.store.state.pairing.consumed, false);
  } finally {
    await server.close();
  }
});

test('oauth: redirect_uri must be a registered exact match', async () => {
  const server = await startServer();
  try {
    const flow = await bootstrapAuthorization(server);

    const otherHost = await submitAuthorize(server, {
      ...flow.query,
      redirect_uri: 'http://127.0.0.1:1/callback',
      csrf_token: flow.csrf,
      code: flow.pairingCode,
    });
    assert.equal(otherHost.status, 400);
    assert.equal(otherHost.headers.get('location'), null);

    // Exact string match: a trailing slash is a different URI.
    const csrf = extractCsrf(await otherHost.text());
    assert.ok(csrf, 'a failed submit re-renders the form with a fresh CSRF token');
    const trailingSlash = await submitAuthorize(server, {
      ...flow.query,
      redirect_uri: `${flow.query.redirect_uri}/`,
      csrf_token: csrf,
      code: flow.pairingCode,
    });
    assert.equal(trailingSlash.status, 400);
    assert.equal(trailingSlash.headers.get('location'), null);

    // The pairing code was never consumed by a rejected submission.
    const accepted = await submitAuthorize(server, {
      ...flow.query,
      csrf_token: extractCsrf(await trailingSlash.text()),
      code: flow.pairingCode,
    });
    assert.equal(accepted.status, 302);
  } finally {
    await server.close();
  }
});

test('oauth: a wrong pairing code re-renders with an error and no redirect', async () => {
  const server = await startServer();
  try {
    const flow = await bootstrapAuthorization(server);
    const rejected = await submitAuthorize(server, {
      ...flow.query,
      csrf_token: flow.csrf,
      code: 'ZZZZ-ZZZZ',
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.headers.get('location'), null);
    const html = await rejected.text();
    assert.match(html, /not right|expired|already used/i);
    assert.equal(server.auth.store.state.pairing.consumed, false);
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------- security --- */

test('oauth: the pairing page escapes a hostile workspace name', async () => {
  const server = await startServer({ workspaceName: '<script>alert(1)</script>' });
  try {
    const { clientId } = await registerClient(server, [server.redirectUri]);
    const { challenge } = pkcePair();
    const page = await openAuthorizePage(
      server,
      authorizeQuery({ clientId, redirectUri: server.redirectUri, challenge }),
    );
    assert.equal(page.response.status, 200);
    assert.ok(page.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.equal(page.html.includes('<script>alert(1)</script>'), false);
    // No external assets, no JavaScript: the page must render with CSS inline only.
    assert.doesNotMatch(page.html, /<script/i);
    assert.doesNotMatch(page.html, /<link\b/i);
    assert.doesNotMatch(page.html, /<img\b/i);
    assert.match(page.html, /<meta name="viewport"/);
    assert.ok(page.csrf);
  } finally {
    await server.close();
  }
});

test('oauth: authenticate() answers 401 with a resource_metadata challenge', async () => {
  const server = await startServer();
  try {
    const expected = `Bearer resource_metadata="${server.base}/.well-known/oauth-protected-resource/${RESOURCE}"`;

    const missing = await server.auth.authenticate({ headers: {}, socket: {} }, { origin: server.base });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 401);
    assert.equal(missing.reason, 'MISSING_TOKEN');
    assert.equal(missing.challenge, expected);

    const unknown = await server.auth.authenticate(
      { headers: { authorization: 'Bearer definitely-not-issued' }, socket: {} },
      { origin: server.base },
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 401);
    assert.equal(unknown.reason, 'UNKNOWN_TOKEN');
    assert.equal(unknown.challenge, expected);

    const malformed = await server.auth.authenticate(
      { headers: { authorization: 'Basic abc' }, socket: {} },
      { origin: server.base },
    );
    assert.equal(malformed.ok, false);
    assert.equal(malformed.status, 401);
    assert.equal(malformed.challenge, expected);
  } finally {
    await server.close();
  }
});

test('oauth: failed authorize submissions are rate limited to 10/min/IP', async () => {
  const server = await startServer();
  try {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const rejected = await submitAuthorize(server, { csrf_token: `bogus-${attempt}`, code: 'ZZZZ-ZZZZ' });
      assert.equal(rejected.status, 400, `attempt ${attempt} should be a plain rejection`);
      await rejected.text();
    }
    const limited = await submitAuthorize(server, { csrf_token: 'bogus-11', code: 'ZZZZ-ZZZZ' });
    assert.equal(limited.status, 429);
    assert.match(await limited.text(), /Too many wrong pairing codes/i);
  } finally {
    await server.close();
  }
});

test('oauth: handle() returns false for a non-auth path', async () => {
  const store = await makeStore();
  try {
    const auth = new AuthServer({ store: store.store, config: { prefix: PREFIX }, log: quietLog() });
    const req = { method: 'GET', url: '/nothing-here', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    const handled = await auth.handle(req, {}, { origin: 'http://127.0.0.1' });
    assert.equal(handled, false);
    // The bridge prefix itself is not an auth route either.
    const prefixOnly = await auth.handle({ ...req, url: `/${PREFIX}/mcp` }, {}, { origin: 'http://127.0.0.1' });
    assert.equal(prefixOnly, false);
  } finally {
    await store.dispose();
  }
});
