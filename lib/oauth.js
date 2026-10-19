// OAuth 2.1 authorization server for the ChatGPT connector.
//
// ChatGPT web speaks a small, standards-shaped subset: dynamic client
// registration, an authorization-code flow with PKCE (S256 only), and rotating
// refresh tokens. The human step is a pairing code: GET /authorize renders a
// server-side HTML page, the user types the code shown in the DSH panel, and only
// then is an authorization code minted. Nothing is ever cached, tokens are
// opaque, and only their SHA-256 hashes touch the state file.
import crypto from 'node:crypto';

import { PairingManager } from './pairing.js';
import {
  nowIso,
  randomToken,
  randomId,
  sha256Hex,
  timingSafeEqual,
  clampInt,
  safeJsonParse,
  sendJson,
  sendEmpty,
  sendText,
  readBody,
  requestUrl,
  truncate,
} from './util.js';

const MAX_REDIRECT_URIS = 16;
const MAX_CLIENT_NAME = 80;
const CSRF_TTL_MS = 30 * 60 * 1000;
const CSRF_MAX_ENTRIES = 1024;
const CLIENT_TOUCH_MS = 5 * 60 * 1000;
const SILENT_LOG = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

/** Render a string as HTML text. Escapes every character that can break out of markup. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** A redirect URI is acceptable when it is https, or plain http on loopback. */
function isAllowedRedirectUri(uri) {
  if (typeof uri !== 'string' || uri.trim() === '' || uri.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
}

function hostOf(uri) {
  try {
    return new URL(String(uri)).host;
  } catch {
    return '';
  }
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(String(verifier), 'ascii').digest('base64url');
}

function isPkceChallenge(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isPkceVerifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

function firstHeader(value) {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

function normalizeSegment(value, fallback) {
  const text = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  return text === '' ? fallback : text;
}

function normalizeMount(value, fallback) {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  const withLeading = text.startsWith('/') ? text : `/${text}`;
  return withLeading.replace(/\/+$/, '');
}

function normalizeSuffix(value, fallback) {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  return `/${text.replace(/^\/+|\/+$/g, '')}`;
}

function pruneState(state, nowMs = Date.now()) {
  for (const [hash, record] of Object.entries(state.codes ?? {})) {
    const expiresAt = Date.parse(record?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt + 3600_000 < nowMs) delete state.codes[hash];
  }
  for (const [hash, record] of Object.entries(state.tokens ?? {})) {
    const expiresAt = Date.parse(record?.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) delete state.tokens[hash];
  }
}

function revokeFamily(state, tokenFamily) {
  for (const [hash, record] of Object.entries(state.tokens ?? {})) {
    if (record?.tokenFamily === tokenFamily) delete state.tokens[hash];
  }
}

function describeClaimFailure(reason) {
  switch (reason) {
    case 'EXPIRED': return 'That pairing code expired. Create a new one in DSH and try again.';
    case 'LOCKED': return 'Too many wrong attempts. Create a new pairing code in DSH.';
    case 'CONSUMED': return 'That pairing code was already used. Create a new one in DSH.';
    default: return 'That pairing code is not right. Check the code and try again.';
  }
}

/**
 * The bridge's own OAuth 2.1 authorization server + resource metadata.
 *
 * Every method here is inert until `handle()` is called with a request: the
 * constructor only validates options and keeps in-memory CSRF/rate-limit maps.
 */
export class AuthServer {
  /**
   * @param {object} options
   * @param {import('./state.js').StateStore} options.store persisted plugin state
   * @param {object} [options.config]
   * @param {string} [options.config.workspaceName] shown on the pairing page
   * @param {string} [options.config.prefix] bridge URL segment (default 'dsh-with-chatgpt')
   * @param {string} [options.config.basePath] mount path for auth endpoints
   * @param {string} [options.config.resourcePath] MCP resource path below the prefix
   * @param {string} [options.config.origin] public origin fallback
   * @param {object} [options.log] logger from createLogger()
   */
  constructor({ store, config = {}, log = null } = {}) {
    if (!store || typeof store.update !== 'function' || typeof store.init !== 'function') {
      const error = new Error('AuthServer requires a StateStore');
      error.code = 'INVALID_ARGS';
      throw error;
    }
    this.store = store;
    this.config = config && typeof config === 'object' ? config : {};
    this.log = log && typeof log === 'object' ? log : SILENT_LOG;

    this.prefix = normalizeSegment(this.config.prefix, 'dsh-with-chatgpt');
    this.basePath = normalizeMount(this.config.basePath, `/${this.prefix}`);
    this.resourcePath = normalizeSuffix(this.config.resourcePath, '/mcp');
    this.workspaceName = typeof this.config.workspaceName === 'string' && this.config.workspaceName.trim() !== ''
      ? truncate(this.config.workspaceName.trim(), 120)
      : 'DSH workspace';

    this.accessTtlSeconds = clampInt(this.config.accessTokenTtlSeconds, 60, 24 * 3600, 3600);
    this.refreshTtlSeconds = clampInt(this.config.refreshTokenTtlSeconds, 300, 90 * 24 * 3600, 30 * 24 * 3600);
    this.codeTtlSeconds = clampInt(this.config.authCodeTtlSeconds, 30, 3600, 300);
    this.bodyLimit = clampInt(this.config.maxBodyBytes, 1024, 1024 * 1024, 64 * 1024);
    this.authRateLimit = clampInt(this.config.authRateLimit, 1, 1000, 10);
    this.authRateWindowMs = clampInt(this.config.authRateWindowMs, 1000, 3600_000, 60_000);

    const pairingConfig = this.config.pairing && typeof this.config.pairing === 'object' ? this.config.pairing : {};
    this.pairing = new PairingManager({ store, ...pairingConfig });

    /** @type {Map<string, number>} CSRF token -> expiry (memory only, like the IP map) */
    this.csrfTokens = new Map();
    /** @type {Map<string, number[]>} failed POST /authorize timestamps per IP */
    this.authFailures = new Map();
    this.lastOrigin = null;
  }

  /* ------------------------------------------------------------- discovery --- */

  /** Absolute URL of the MCP resource advertised in protected-resource metadata. */
  resourceUrl(origin) {
    return `${origin}/${this.prefix}${this.resourcePath}`;
  }

  /** Absolute URL of the RFC 9728 metadata document ChatGPT re-fetches after a 401. */
  resourceMetadataUrl(origin) {
    return `${origin}/.well-known/oauth-protected-resource/${this.prefix}${this.resourcePath}`;
  }

  /** The exact `WWW-Authenticate` value that points ChatGPT at the metadata. */
  challengeFor(origin) {
    return `Bearer resource_metadata="${this.resourceMetadataUrl(origin)}"`;
  }

  /* ----------------------------------------------------------------- routes --- */

  /**
   * Handle one auth-related request. Returns true when it wrote the response.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{origin?:string, url?:URL|string, clientIp?:string}} [context]
   * @returns {Promise<boolean>}
   */
  async handle(req, res, { origin, url, clientIp } = {}) {
    await this.store.init();
    const target = this.#targetUrl(req, url);
    const originValue = this.#originOf(req, origin);
    this.lastOrigin = originValue;
    const ip = typeof clientIp === 'string' && clientIp.trim() !== ''
      ? clientIp.trim()
      : (req.socket?.remoteAddress || 'unknown');
    const context = {
      origin: originValue,
      ip,
      method: String(req.method || 'GET').toUpperCase(),
      url: target,
      paths: this.#relativePaths(target.pathname),
    };

    try {
      if (this.#isProtectedResourceMetadata(context.paths)) {
        if (!this.#allowMethod(req, res, context.method, ['GET', 'HEAD'])) return true;
        sendJson(res, 200, {
          resource: this.resourceUrl(originValue),
          authorization_servers: [originValue],
          bearer_methods_supported: ['header'],
          scopes_supported: [],
        });
        return true;
      }

      if (this.#isAuthorizationServerMetadata(context.paths)) {
        if (!this.#allowMethod(req, res, context.method, ['GET', 'HEAD'])) return true;
        sendJson(res, 200, {
          issuer: originValue,
          authorization_endpoint: `${originValue}${this.basePath}/authorize`,
          token_endpoint: `${originValue}${this.basePath}/token`,
          registration_endpoint: `${originValue}${this.basePath}/register`,
          revocation_endpoint: `${originValue}${this.basePath}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
          revocation_endpoint_auth_methods_supported: ['none'],
          scopes_supported: [],
        });
        return true;
      }

      if (context.paths.has('/register')) {
        await this.#handleRegister(req, res, context);
        return true;
      }

      if (context.paths.has('/authorize')) {
        if (context.method === 'POST') await this.#handleAuthorizePost(req, res, context);
        else if (!this.#allowMethod(req, res, context.method, ['GET', 'HEAD'])) return true;
        else this.#handleAuthorizeGet(req, res, context);
        return true;
      }

      if (context.paths.has('/token')) {
        await this.#handleToken(req, res, context);
        return true;
      }

      if (context.paths.has('/revoke')) {
        await this.#handleRevoke(req, res, context);
        return true;
      }
    } catch (error) {
      this.log.error('auth request failed:', error?.code ?? '', error?.message ?? String(error));
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'server_error', error_description: 'The bridge could not complete the request.' });
      }
      return true;
    }

    return false;
  }

  /* ------------------------------------------------------------- resource --- */

  /**
   * Validate a `Authorization: Bearer <token>` header.
   * @param {import('node:http').IncomingMessage} req
   * @param {{origin?:string}} [options] override the origin used in the metadata challenge
   * @returns {Promise<{ok:true, clientId:string, scope:string} | {ok:false, status:401|403, reason:string, challenge?:string}>}
   */
  async authenticate(req, options = {}) {
    await this.store.init();
    const origin = (typeof options?.origin === 'string' && options.origin.trim() !== '' ? options.origin.trim() : '')
      || (typeof this.config.origin === 'string' && this.config.origin.trim() !== '' ? this.config.origin.trim() : '')
      || this.lastOrigin
      || this.#originOf(req, undefined);
    const challenge = this.challengeFor(origin);
    const header = req?.headers?.authorization;
    if (typeof header !== 'string' || header.trim() === '') {
      return { ok: false, status: 401, reason: 'MISSING_TOKEN', challenge };
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) return { ok: false, status: 401, reason: 'INVALID_AUTHORIZATION_HEADER', challenge };
    const token = match[1];
    const record = this.store.state.tokens?.[sha256Hex(token)];
    if (!record) return { ok: false, status: 401, reason: 'UNKNOWN_TOKEN', challenge };
    if (record.kind !== 'access') return { ok: false, status: 403, reason: 'NOT_AN_ACCESS_TOKEN' };
    const expiresAt = Date.parse(record.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      return { ok: false, status: 401, reason: 'TOKEN_EXPIRED', challenge };
    }
    const client = this.store.state.clients?.[record.clientId];
    if (!client) return { ok: false, status: 403, reason: 'CLIENT_REVOKED' };
    await this.#touchClient(record.clientId, client);
    return { ok: true, clientId: record.clientId, scope: record.scope ?? '' };
  }

  /** Drop every client, code and token: a full lockout of every ChatGPT connector. */
  async revokeAll() {
    await this.store.init();
    await this.store.update((state) => {
      state.clients = {};
      state.codes = {};
      state.tokens = {};
    });
    this.csrfTokens.clear();
    this.lastOrigin = null;
    this.log.info('all clients and tokens revoked');
    return { ok: true };
  }

  /** @returns {Array<{clientId:string, clientName:string, createdAt:string|null, lastUsedAt:string|null}>} */
  listClients() {
    const clients = this.store.state.clients ?? {};
    return Object.values(clients).map((client) => ({
      clientId: client.clientId,
      clientName: client.clientName ?? 'ChatGPT',
      createdAt: client.createdAt ?? null,
      lastUsedAt: client.lastUsedAt ?? null,
    }));
  }

  /** @returns {boolean} true while at least one unexpired access or refresh token exists. */
  hasActiveTokens() {
    const now = Date.now();
    const tokens = this.store.state.tokens ?? {};
    return Object.values(tokens).some((record) => {
      const expiresAt = Date.parse(record?.expiresAt ?? '');
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
  }

  /* ------------------------------------------------------------ registration --- */

  async #handleRegister(req, res, context) {
    if (!this.#allowMethod(req, res, context.method, ['POST'])) return;
    const body = await this.#readBody(req, res);
    if (body === null) return;
    const payload = safeJsonParse(body.toString('utf8').trim() || '{}', null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'The registration body must be a JSON object.' });
      return;
    }
    const redirectUris = Array.isArray(payload.redirect_uris)
      ? payload.redirect_uris.filter((uri) => typeof uri === 'string').map((uri) => uri.trim()).filter((uri) => uri !== '')
      : [];
    if (redirectUris.length === 0) {
      sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: 'At least one redirect_uri is required.' });
      return;
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      sendJson(res, 400, { error: 'invalid_redirect_uri', error_description: `At most ${MAX_REDIRECT_URIS} redirect_uris are supported.` });
      return;
    }
    const bad = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
    if (bad !== undefined) {
      sendJson(res, 400, {
        error: 'invalid_redirect_uri',
        error_description: 'Every redirect_uri must be https or plain http on a loopback host.',
      });
      return;
    }

    const clientName = typeof payload.client_name === 'string' && payload.client_name.trim() !== ''
      ? truncate(payload.client_name.trim().replace(/[\u0000-\u001f\u007f]/g, ''), MAX_CLIENT_NAME)
      : 'ChatGPT';
    const clientId = randomId('dshc_', 16);
    const createdAt = nowIso();
    await this.store.update((state) => {
      pruneState(state);
      state.clients[clientId] = {
        clientId,
        clientName,
        redirectUris,
        scope: typeof payload.scope === 'string' ? truncate(payload.scope, 200) : '',
        createdAt,
        lastUsedAt: null,
      };
    });
    this.log.debug('registered client', clientId, 'redirect uris:', redirectUris.length);
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  /* -------------------------------------------------------------- authorize --- */

  #handleAuthorizeGet(req, res, context) {
    const query = context.url.searchParams;
    const values = {
      client_id: query.get('client_id') ?? '',
      redirect_uri: query.get('redirect_uri') ?? '',
      state: query.get('state') ?? '',
      code_challenge: query.get('code_challenge') ?? '',
      code_challenge_method: query.get('code_challenge_method') ?? '',
      response_type: query.get('response_type') ?? 'code',
      scope: query.get('scope') ?? '',
    };
    const problem = this.#authorizeProblem(values);
    if (problem) {
      this.#renderPage(res, 400, { error: problem, values, form: false });
      return;
    }
    this.log.debug('pairing page rendered for client', values.client_id);
    this.#renderPage(res, 200, { values, form: true });
  }

  async #handleAuthorizePost(req, res, context) {
    // Read (and drain) the capped body first: it keeps the connection clean when
    // the rate limiter refuses the request below.
    const body = await this.#readBody(req, res);
    if (body === null) return;
    if (this.#authorizeRateLimited(context.ip)) {
      this.log.warn('authorize rate limit hit for', context.ip);
      this.#renderPage(res, 429, {
        error: 'Too many wrong pairing codes. Wait a minute and try again.',
        values: {},
        form: false,
      });
      return;
    }
    const form = new URLSearchParams(body.toString('utf8'));
    const values = {
      csrf_token: form.get('csrf_token') ?? '',
      client_id: form.get('client_id') ?? '',
      redirect_uri: form.get('redirect_uri') ?? '',
      state: form.get('state') ?? '',
      code_challenge: form.get('code_challenge') ?? '',
      code_challenge_method: form.get('code_challenge_method') ?? '',
      response_type: form.get('response_type') ?? 'code',
      scope: form.get('scope') ?? '',
      code: form.get('code') ?? '',
    };

    if (!this.#consumeCsrf(values.csrf_token)) {
      this.#recordAuthorizeFailure(context.ip);
      this.#renderPage(res, 400, {
        error: 'This pairing page expired before it was submitted. Reopen the pairing link and try again.',
        values,
        form: true,
      });
      return;
    }

    const problem = this.#authorizeProblem(values);
    if (problem) {
      this.#recordAuthorizeFailure(context.ip);
      this.#renderPage(res, 400, { error: problem, values, form: true });
      return;
    }

    const claim = await this.pairing.claim({ code: values.code, ip: context.ip });
    if (!claim.ok) {
      this.#recordAuthorizeFailure(context.ip);
      this.log.warn('pairing claim rejected:', claim.reason);
      this.#renderPage(res, 200, { error: describeClaimFailure(claim.reason), values, form: true });
      return;
    }

    const rawCode = randomToken(32);
    const codeHash = sha256Hex(rawCode);
    const expiresAt = new Date(Date.now() + this.codeTtlSeconds * 1000).toISOString();
    const createdAt = nowIso();
    await this.store.update((state) => {
      pruneState(state);
      state.codes[codeHash] = {
        clientId: values.client_id,
        redirectUri: values.redirect_uri,
        codeChallenge: values.code_challenge,
        scope: values.scope,
        expiresAt,
        createdAt,
        usedAt: null,
      };
      const client = state.clients[values.client_id];
      if (client) client.lastUsedAt = createdAt;
    });
    this.log.info('paired client', values.client_id);

    const location = new URL(values.redirect_uri);
    location.searchParams.set('code', rawCode);
    if (values.state !== '') location.searchParams.set('state', values.state);
    sendEmpty(res, 302, { location: location.toString(), 'content-length': '0' });
  }

  #authorizeProblem(values) {
    if (values.response_type && values.response_type !== 'code') {
      return 'Only the authorization code flow (response_type=code) is supported.';
    }
    const client = values.client_id ? this.store.state.clients?.[values.client_id] : null;
    if (!client) return 'Unknown client. Start the connection again from ChatGPT.';
    if (!values.redirect_uri) return 'Missing redirect_uri.';
    if (!Array.isArray(client.redirectUris) || !client.redirectUris.includes(values.redirect_uri)) {
      return 'This redirect_uri is not registered for the client.';
    }
    if (!values.code_challenge) return 'Missing PKCE code_challenge.';
    if (values.code_challenge_method !== 'S256') return 'Only the PKCE S256 code_challenge_method is supported.';
    if (!isPkceChallenge(values.code_challenge)) return 'The PKCE code_challenge is malformed.';
    return null;
  }

  /* ------------------------------------------------------------------ token --- */

  async #handleToken(req, res, context) {
    if (!this.#allowMethod(req, res, context.method, ['POST'])) return;
    const body = await this.#readBody(req, res);
    if (body === null) return;
    const form = new URLSearchParams(body.toString('utf8'));
    const grantType = form.get('grant_type') ?? '';
    if (grantType === 'authorization_code') {
      await this.#grantAuthorizationCode(res, form);
      return;
    }
    if (grantType === 'refresh_token') {
      await this.#grantRefreshToken(res, form);
      return;
    }
    if (grantType === '') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'grant_type is required.' });
      return;
    }
    sendJson(res, 400, { error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${truncate(grantType, 40)}` });
  }

  async #grantAuthorizationCode(res, form) {
    const code = form.get('code') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const clientId = form.get('client_id') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    if (code === '') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'code is required.' });
      return;
    }
    if (clientId === '') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'client_id is required.' });
      return;
    }
    if (redirectUri === '') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'redirect_uri is required.' });
      return;
    }
    if (verifier === '') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'code_verifier is required (PKCE).' });
      return;
    }
    if (!isPkceVerifier(verifier)) {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'code_verifier is malformed.' });
      return;
    }

    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const tokenFamily = randomId('fam_', 12);
    const accessHash = sha256Hex(accessToken);
    const refreshHash = sha256Hex(refreshToken);
    const codeHash = sha256Hex(code);
    const accessExpiresAt = new Date(Date.now() + this.accessTtlSeconds * 1000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000).toISOString();
    const createdAt = nowIso();

    const outcome = await this.store.update((state) => {
      const record = state.codes?.[codeHash];
      if (!record) return { error: 'invalid_grant', description: 'Unknown authorization code.' };
      if (record.usedAt) {
        delete state.codes[codeHash];
        return { error: 'invalid_grant', description: 'The authorization code was already used.' };
      }
      const codeExpiresAt = Date.parse(record.expiresAt ?? '');
      if (!Number.isFinite(codeExpiresAt) || codeExpiresAt <= Date.now()) {
        delete state.codes[codeHash];
        return { error: 'invalid_grant', description: 'The authorization code expired.' };
      }
      if (record.clientId !== clientId) {
        return { error: 'invalid_grant', description: 'The authorization code was issued to another client.' };
      }
      if (record.redirectUri !== redirectUri) {
        return { error: 'invalid_grant', description: 'redirect_uri does not match the authorization request.' };
      }
      const expectedChallenge = pkceChallenge(verifier);
      if (!timingSafeEqual(expectedChallenge, record.codeChallenge ?? '')) {
        return { error: 'invalid_grant', description: 'PKCE verification failed.' };
      }
      record.usedAt = nowIso();
      pruneState(state);
      state.tokens[accessHash] = {
        kind: 'access',
        clientId,
        scope: record.scope ?? '',
        expiresAt: accessExpiresAt,
        createdAt,
        tokenFamily,
      };
      state.tokens[refreshHash] = {
        kind: 'refresh',
        clientId,
        scope: record.scope ?? '',
        expiresAt: refreshExpiresAt,
        createdAt,
        tokenFamily,
      };
      const client = state.clients?.[clientId];
      if (client) client.lastUsedAt = createdAt;
      return { scope: record.scope ?? '' };
    });

    if (outcome.error) {
      this.log.warn('token request rejected:', outcome.description);
      sendJson(res, 400, { error: outcome.error, error_description: outcome.description });
      return;
    }
    sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTtlSeconds,
      refresh_token: refreshToken,
      scope: outcome.scope,
    });
  }

  async #grantRefreshToken(res, form) {
    const refreshToken = form.get('refresh_token') ?? '';
    const clientId = form.get('client_id') ?? '';
    if (refreshToken === '') {
      sendJson(res, 400, { error: 'invalid_request', error_description: 'refresh_token is required.' });
      return;
    }

    const accessToken = randomToken(32);
    const nextRefreshToken = randomToken(32);
    const accessHash = sha256Hex(accessToken);
    const refreshHash = sha256Hex(nextRefreshToken);
    const lookupHash = sha256Hex(refreshToken);
    const accessExpiresAt = new Date(Date.now() + this.accessTtlSeconds * 1000).toISOString();
    const refreshExpiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000).toISOString();
    const createdAt = nowIso();

    const outcome = await this.store.update((state) => {
      const record = state.tokens?.[lookupHash];
      if (!record || record.kind !== 'refresh') {
        return { error: 'invalid_grant', description: 'Unknown refresh token.' };
      }
      if (record.rotatedAt) {
        // A rotated refresh token coming back is a replay: kill the whole family.
        revokeFamily(state, record.tokenFamily);
        return { error: 'invalid_grant', description: 'Refresh token reuse detected; the token family was revoked.' };
      }
      const expiresAt = Date.parse(record.expiresAt ?? '');
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        delete state.tokens[lookupHash];
        return { error: 'invalid_grant', description: 'The refresh token expired.' };
      }
      if (clientId !== '' && record.clientId !== clientId) {
        return { error: 'invalid_grant', description: 'The refresh token was issued to another client.' };
      }
      const client = state.clients?.[record.clientId];
      if (!client) {
        delete state.tokens[lookupHash];
        return { error: 'invalid_grant', description: 'The client is no longer registered.' };
      }
      record.rotatedAt = createdAt;
      state.tokens[accessHash] = {
        kind: 'access',
        clientId: record.clientId,
        scope: record.scope ?? '',
        expiresAt: accessExpiresAt,
        createdAt,
        tokenFamily: record.tokenFamily,
      };
      state.tokens[refreshHash] = {
        kind: 'refresh',
        clientId: record.clientId,
        scope: record.scope ?? '',
        expiresAt: refreshExpiresAt,
        createdAt,
        tokenFamily: record.tokenFamily,
      };
      pruneState(state);
      client.lastUsedAt = createdAt;
      return { scope: record.scope ?? '' };
    });

    if (outcome.error) {
      this.log.warn('refresh rejected:', outcome.description);
      sendJson(res, 400, { error: outcome.error, error_description: outcome.description });
      return;
    }
    sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.accessTtlSeconds,
      refresh_token: nextRefreshToken,
      scope: outcome.scope,
    });
  }

  async #handleRevoke(req, res, context) {
    if (!this.#allowMethod(req, res, context.method, ['POST'])) return;
    const body = await this.#readBody(req, res);
    if (body === null) return;
    const form = new URLSearchParams(body.toString('utf8'));
    const token = form.get('token') ?? '';
    if (token !== '') {
      const hash = sha256Hex(token);
      await this.store.update((state) => {
        const record = state.tokens?.[hash];
        if (!record) return;
        if (record.kind === 'refresh') revokeFamily(state, record.tokenFamily);
        else delete state.tokens[hash];
      });
      this.log.debug('revoked token', hash.slice(0, 8));
    }
    // RFC 7009: always answer 200, even for an unknown or missing token.
    sendEmpty(res, 200, { 'content-length': '0' });
  }

  /* ------------------------------------------------------------------ utils --- */

  #targetUrl(req, url) {
    if (url instanceof URL) return url;
    if (typeof url === 'string' && url.trim() !== '') {
      try {
        return new URL(url, 'http://127.0.0.1');
      } catch {
        // fall through to requestUrl()
      }
    }
    return requestUrl(req);
  }

  #originOf(req, origin) {
    if (typeof origin === 'string' && origin.trim() !== '') return origin.trim().replace(/\/+$/, '');
    const configured = typeof this.config.origin === 'string' ? this.config.origin.trim() : '';
    if (configured !== '') return configured.replace(/\/+$/, '');
    const headers = req?.headers ?? {};
    const proto = firstHeader(headers['x-forwarded-proto']) || (req?.socket?.encrypted ? 'https' : 'http');
    const host = firstHeader(headers['x-forwarded-host']) || firstHeader(headers.host);
    return host === '' ? 'http://127.0.0.1' : `${proto}://${host}`;
  }

  #relativePaths(pathname) {
    const raw = typeof pathname === 'string' && pathname !== '' ? pathname : '/';
    const normalize = (value) => {
      if (value === '' || value === '/') return '/';
      return value.replace(/\/+$/, '') || '/';
    };
    const paths = new Set([normalize(raw)]);
    const strip = (value, mount) => {
      const base = normalizeMount(mount, '');
      if (base === '') return null;
      if (value === base) return '/';
      if (value.startsWith(`${base}/`)) return value.slice(base.length);
      return null;
    };
    const candidates = [strip(raw, `/${this.prefix}`), strip(raw, this.basePath)];
    for (const candidate of candidates) {
      if (candidate === null) continue;
      const rel = normalize(candidate);
      paths.add(rel);
      const nested = /^\/(oauth|auth)(\/.*)?$/.exec(rel);
      if (nested) paths.add(normalize(nested[2] ?? '/'));
    }
    return paths;
  }

  #isProtectedResourceMetadata(paths) {
    const rootPath = '/.well-known/oauth-protected-resource';
    for (const candidate of paths) {
      if (candidate === rootPath) return true;
      if (!candidate.startsWith(`${rootPath}/`)) continue;
      const tail = candidate.slice(rootPath.length + 1);
      if (tail === 'mcp') return true;
      if (tail === `${this.prefix}${this.resourcePath}`) return true;
    }
    return false;
  }

  #isAuthorizationServerMetadata(paths) {
    const rootPath = '/.well-known/oauth-authorization-server';
    for (const candidate of paths) {
      if (candidate === rootPath) return true;
      if (!candidate.startsWith(`${rootPath}/`)) continue;
      if (candidate.slice(rootPath.length + 1) === this.prefix) return true;
    }
    return false;
  }

  #allowMethod(req, res, method, allowed) {
    if (allowed.includes(method)) return true;
    sendJson(res, 405, { error: 'invalid_request', error_description: `Method ${method} is not allowed here.` }, { allow: allowed.join(', ') });
    return false;
  }

  async #readBody(req, res) {
    try {
      return await readBody(req, this.bodyLimit);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') {
        sendJson(res, 413, { error: 'invalid_request', error_description: 'Request body is too large.' });
        return null;
      }
      throw error;
    }
  }

  #mintCsrf() {
    const now = Date.now();
    if (this.csrfTokens.size >= CSRF_MAX_ENTRIES) {
      for (const [token, expiresAt] of this.csrfTokens) {
        if (expiresAt <= now) this.csrfTokens.delete(token);
      }
      if (this.csrfTokens.size >= CSRF_MAX_ENTRIES) this.csrfTokens.clear();
    }
    const token = randomToken(24);
    this.csrfTokens.set(token, now + CSRF_TTL_MS);
    return token;
  }

  #consumeCsrf(value) {
    if (typeof value !== 'string' || value === '') return false;
    const expiresAt = this.csrfTokens.get(value);
    this.csrfTokens.delete(value);
    if (typeof expiresAt !== 'number') return false;
    return expiresAt > Date.now();
  }

  #authorizeRateLimited(ip) {
    const cutoff = Date.now() - this.authRateWindowMs;
    const recent = (this.authFailures.get(ip) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length === 0) this.authFailures.delete(ip);
    else this.authFailures.set(ip, recent);
    return recent.length >= this.authRateLimit;
  }

  #recordAuthorizeFailure(ip) {
    const cutoff = Date.now() - this.authRateWindowMs;
    const recent = (this.authFailures.get(ip) ?? []).filter((timestamp) => timestamp > cutoff);
    recent.push(Date.now());
    const cap = this.authRateLimit * 2;
    if (recent.length > cap) recent.splice(0, recent.length - cap);
    this.authFailures.set(ip, recent);
  }

  async #touchClient(clientId, client) {
    const last = Date.parse(client.lastUsedAt ?? '');
    if (Number.isFinite(last) && Date.now() - last < CLIENT_TOUCH_MS) return;
    await this.store.update((state) => {
      const current = state.clients?.[clientId];
      if (current) current.lastUsedAt = nowIso();
    });
  }

  /* ------------------------------------------------------------------- html --- */

  #renderPage(res, status, { error, values, form }) {
    const csrf = this.#mintCsrf();
    const nameEscaped = escapeHtml(this.workspaceName);
    const redirectHost = hostOf(values.redirect_uri) || 'unknown host';
    const hidden = form
      ? [
        ['csrf_token', csrf],
        ['client_id', values.client_id ?? ''],
        ['redirect_uri', values.redirect_uri ?? ''],
        ['state', values.state ?? ''],
        ['code_challenge', values.code_challenge ?? ''],
        ['code_challenge_method', values.code_challenge_method ?? ''],
        ['response_type', 'code'],
        ['scope', values.scope ?? ''],
      ].map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join('\n      ')
      : '';
    const errorBlock = typeof error === 'string' && error !== ''
      ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
      : '';
    const formBlock = form
      ? `<form method="post" action="authorize" autocomplete="off">
      ${hidden}
      <label for="pairing-code">Pairing code</label>
      <input id="pairing-code" name="code" type="text" inputmode="text" placeholder="XXXX-XXXX"
        autocomplete="one-time-code" autocapitalize="characters" spellcheck="false"
        maxlength="9" pattern="[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}" required autofocus>
      <button type="submit">Pair this browser</button>
    </form>`
      : '';
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex, nofollow">
  <title>Pair with ${nameEscaped}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #f4f5f7; color: #1b1d21; }
    .card { width: 100%; max-width: 420px; padding: 28px 26px 24px; border-radius: 14px;
      background: #ffffff; border: 1px solid #e2e4e9; box-shadow: 0 12px 32px rgba(15, 18, 24, 0.08); }
    h1 { margin: 0 0 6px; font-size: 20px; line-height: 1.3; }
    .lede { margin: 0 0 18px; color: #5b6169; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0 0 20px;
      padding: 12px 14px; border-radius: 10px; background: #f7f8fa; }
    dt { color: #5b6169; }
    dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    label { display: block; margin-bottom: 6px; font-weight: 600; }
    input[type="text"] { width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #c9ced6;
      font: inherit; letter-spacing: 2px; text-transform: uppercase; background: #fff; color: inherit; }
    input[type="text"]:focus { outline: 2px solid #3b6ff5; outline-offset: 1px; border-color: #3b6ff5; }
    button { width: 100%; margin-top: 14px; padding: 11px 16px; border: 0; border-radius: 9px;
      font: inherit; font-weight: 600; color: #fff; background: #2f6bf2; cursor: pointer; }
    button:hover { background: #1f57d6; }
    .error { margin: 0 0 16px; padding: 10px 12px; border-radius: 9px; background: #fdecec;
      border: 1px solid #f5b5b5; color: #8a1c1c; }
    .hint { margin: 18px 0 0; font-size: 13px; color: #6b727b; }
    code { font: 13px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
    @media (prefers-color-scheme: dark) {
      body { background: #0f1115; color: #e8eaed; }
      .card { background: #171a1f; border-color: #2a2f37; box-shadow: none; }
      .lede, dt, .hint { color: #a3aab4; }
      dl { background: #1d2127; }
      input[type="text"] { background: #12151a; border-color: #333a44; }
      .error { background: #2a1618; border-color: #5c2a2e; color: #f4b8b8; }
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Pair ChatGPT with ${nameEscaped}</h1>
    <p class="lede">ChatGPT is asking this bridge for read-only access to your local workspace.</p>
    <dl>
      <dt>Workspace</dt><dd>${nameEscaped}</dd>
      <dt>Returns to</dt><dd><code>${escapeHtml(redirectHost)}</code></dd>
    </dl>
    ${errorBlock}
    ${formBlock}
    <p class="hint">Open the DSH panel &rarr; Settings &rarr; ChatGPT to create a pairing code. The code is single use and expires after five minutes.</p>
  </main>
</body>
</html>
`;
    sendText(res, status, html, 'text/html; charset=utf-8');
  }
}
