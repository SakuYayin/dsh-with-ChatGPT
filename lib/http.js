// HTTP surface of the bridge: the MCP endpoint (Streamable HTTP, stateless), the
// OAuth endpoints, and the same-origin state API the settings panel talks to.
//
// Every request is fenced twice:
//   1. the state API answers loopback requests only,
//   2. /mcp always requires an OAuth bearer token, because the tunnel makes it
//      reachable from the public internet.
//
// Route layout (all under `config.prefix`, default `/dsh-with-chatgpt`):
//   <prefix>/mcp                                  MCP transport
//   <prefix>/api/state | pairing | connect | ...  settings panel
//   <prefix>/register | authorize | token | revoke
//   /.well-known/oauth-protected-resource[/<prefix>/mcp]
//   /.well-known/oauth-authorization-server

import { createServer } from 'node:http';
import { createMcp } from './mcp.js';
import { isLoopbackRequest, nowIso, readBody, sendEmpty, sendJson, sendText } from './util.js';

const MAX_JSONRPC_BODY = 4 * 1024 * 1024;

/** Accept-header negotiation for Streamable HTTP. */
function wantsStream(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

/**
 * Stateless Streamable-HTTP MCP transport: one JSON-RPC message (or a batch) per
 * request, answered with plain JSON unless the client insists on SSE.
 */
export class McpTransport {
  constructor({ mcp, auth, log }) {
    this.mcp = mcp;
    this.auth = auth;
    this.log = log;
  }

  async handle(req, res) {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST, DELETE' });
      return true;
    }

    const auth = await this.auth.authenticate(req);
    if (!auth.ok) {
      sendJson(res, auth.status, {
        error: auth.status === 401 ? 'unauthorized' : 'forbidden',
        error_description: auth.reason ?? 'authentication required',
      }, { 'www-authenticate': auth.challenge ?? 'Bearer' });
      return true;
    }

    if (method === 'DELETE') {
      // Stateless transport: nothing to terminate.
      sendEmpty(res, 200);
      return true;
    }
    if (method === 'GET') {
      // A stateless transport offers no server-initiated stream.
      sendEmpty(res, 405, { allow: 'POST' });
      return true;
    }

    let payload;
    try {
      const body = await readBody(req, MAX_JSONRPC_BODY);
      payload = JSON.parse(body.toString('utf8'));
    } catch (error) {
      const tooLarge = error?.code === 'BODY_TOO_LARGE';
      sendJson(res, tooLarge ? 413 : 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: tooLarge ? 'request body too large' : 'parse error' },
      });
      return true;
    }

    const reply = await dispatchBatch(this.mcp, payload);
    if (reply === undefined) {
      // Notification-only payload: the spec answers 202 with no body.
      sendEmpty(res, 202);
      return true;
    }
    if (wantsStream(req)) {
      sendText(res, 200, `event: message\ndata: ${JSON.stringify(reply)}\n\n`, 'text/event-stream; charset=utf-8', {
        'cache-control': 'no-store',
      });
      return true;
    }
    sendJson(res, 200, reply);
    return true;
  }
}

async function dispatchBatch(mcp, payload) {
  if (Array.isArray(payload)) {
    if (payload.length === 0) return undefined;
    const replies = [];
    for (const message of payload) {
      const reply = await mcp.handle(message);
      if (reply !== undefined) replies.push(reply);
    }
    return replies.length === 0 ? undefined : replies;
  }
  if (payload === null || typeof payload !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  return mcp.handle(payload);
}

/**
 * The whole HTTP bridge: routes the well-known metadata, the auth endpoints, the
 * MCP endpoint and the panel API.
 */
export class BridgeHttp {
  constructor({ store, auth, pairing, tunnel, control, journal, workspace, mcp, config, log, bridge }) {
    this.store = store;
    this.auth = auth;
    this.pairing = pairing;
    this.tunnel = tunnel;
    this.control = control;
    this.journal = journal;
    this.workspace = workspace;
    this.mcp = mcp;
    this.config = config;
    this.log = log;
    this.bridge = bridge;
    this.prefix = config.prefix;
    this.server = undefined;
    this.origin = undefined;
    this.transport = new McpTransport({ mcp, auth, log });
  }

  /** Absolute URL of the MCP endpoint as seen from this request. */
  mcpUrlFor(origin) {
    return `${origin}${this.prefix}/mcp`;
  }

  /**
   * Self-hosted HTTP surface. The desktop profile provides no shared `webServer`
   * service, so the bridge owns a plain node:http listener. Everything the tunnel
   * forwards and every local panel request lands in the same `handle()`.
   * @returns {Promise<string>} the listening origin, e.g. `http://127.0.0.1:3780`
   */
  start() {
    if (this.server) return Promise.resolve(this.origin);
    const port = Number(this.config.port) || 3780;
    const host = String(this.config.host ?? '127.0.0.1') || '127.0.0.1';
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        Promise.resolve(this.handle(req, res)).catch((error) => {
          this.log?.warn?.('http handler error', error?.message ?? error);
          try {
            sendJson(res, 500, { error: 'internal_error', error_description: error?.message ?? 'failed' });
          } catch { /* response already gone */ }
        });
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const address = server.address();
        this.server = server;
        // An ephemeral port (0) resolves to the actually chosen one; a named
        // IPv6 host needs brackets to stay a valid URL authority.
        const shownHost = String(address.address).includes(':') ? `[${address.address}]` : address.address;
        this.origin = `http://${shownHost}:${address.port}`;
        this.log?.debug?.('bridge http listening', this.origin);
        resolve(this.origin);
      });
    });
  }

  /** Stop the self-hosted listener; idempotent. */
  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.origin = undefined;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  isWellKnownPath(pathname) {
    return (
      pathname === '/.well-known/oauth-protected-resource'
      || pathname.startsWith('/.well-known/oauth-protected-resource/')
      || pathname.startsWith('/.well-known/oauth-authorization-server')
    );
  }

  /**
   * Route one request.
   * @returns {Promise<boolean>} true when handled
   */
  async handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      sendJson(res, 400, { error: 'bad_request' });
      return true;
    }
    const pathname = url.pathname;
    const origin = requestOrigin(req, url);
    const clientIp = clientIpOf(req);

    if (this.isWellKnownPath(pathname)) {
      // The metadata is mounted at the web-server root, but the auth server renders
      // it as if it lived under the bridge prefix.
      const local = new URL(`${this.prefix}${pathname}${url.search}`, url.origin);
      return this.auth.handle(req, res, { origin, url: local, clientIp });
    }

    if (pathname === this.prefix || pathname === `${this.prefix}/`) {
      if (String(req.method ?? '').toUpperCase() !== 'GET') {
        sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
        return true;
      }
      sendText(res, 200, 'dsh-with-chatgpt bridge is running\n', 'text/plain; charset=utf-8');
      return true;
    }

    if (!pathname.startsWith(`${this.prefix}/`)) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }

    const subPath = pathname.slice(this.prefix.length) || '/';
    const local = new URL(`${subPath}${url.search}`, url.origin);

    if (subPath === '/mcp' || subPath === '/mcp/') {
      return this.transport.handle(req, res);
    }

    if (subPath.startsWith('/api/')) {
      if (!isPanelRequest(req)) {
        sendJson(res, 403, { error: 'forbidden', error_description: 'the state API answers local requests only' });
        return true;
      }
      return this.handleApi(req, res, subPath);
    }

    const handled = await this.auth.handle(req, res, { origin, url: local, clientIp });
    if (handled) return true;

    sendJson(res, 404, { error: 'not_found' });
    return true;
  }

  async handleApi(req, res, pathname) {
    const method = String(req.method ?? 'GET').toUpperCase();
    try {
      if (pathname === '/api/state' && method === 'GET') {
        sendJson(res, 200, await this.stateSnapshot());
        return true;
      }
      if (pathname === '/api/pairing' && method === 'POST') {
        const issued = await this.pairing.issue();
        sendJson(res, 200, { ok: true, ...issued });
        return true;
      }
      if (pathname === '/api/connect' && method === 'POST') {
        const result = await this.bridge.connect();
        sendJson(res, result.ok ? 200 : 502, result);
        return true;
      }
      if (pathname === '/api/disconnect' && method === 'POST') {
        await this.bridge.disconnect();
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (pathname === '/api/revoke' && method === 'POST') {
        await this.auth.revokeAll();
        await this.pairing.revoke();
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (pathname === '/api/boot-prompt' && method === 'GET') {
        sendJson(res, 200, { ok: true, ...(await this.bridge.bootPrompt()) });
        return true;
      }
      sendJson(res, 404, { error: 'not_found' });
      return true;
    } catch (error) {
      this.log?.warn?.('api error', pathname, error?.message);
      sendJson(res, 500, { error: 'internal_error', error_description: error?.message ?? 'failed' });
      return true;
    }
  }

  /** Everything the settings panel renders. */
  async stateSnapshot() {
    const tunnel = this.tunnel.status();
    const pairing = this.pairing.status();
    const clients = this.auth.listClients();
    const session = this.store.session;
    return {
      at: nowIso(),
      version: this.config.version ?? null,
      workspace: {
        name: this.workspace?.name ?? null,
        root: this.workspace?.root ?? null,
      },
      bridge: {
        running: true,
        origin: this.bridge.localOrigin,
        mcpUrl: this.bridge.mcpUrl,
        publicOrigin: this.bridge.publicOrigin ?? null,
        authenticated: this.auth.hasActiveTokens(),
      },
      tunnel,
      pairing,
      clients,
      session,
      iterations: Number(this.store.state.counters?.iterations) || 0,
      maxIterations: this.config.maxIterations,
      prompt: {
        connectorName: this.bridge.connectorName,
        bootPrompt: this.bridge.bootPromptSync(),
      },
    };
  }
}

function requestOrigin(req, url) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? url.host).split(',')[0].trim();
  const scheme = proto !== '' ? proto : (url.protocol === 'https:' ? 'https' : 'http');
  return `${scheme}://${host}`;
}

function clientIpOf(req) {
  const forwarded = String(req.headers['cf-connecting-ip'] ?? '').split(',')[0].trim();
  if (forwarded !== '') return forwarded;
  const real = String(req.headers['x-real-ip'] ?? '').split(',')[0].trim();
  if (real !== '') return real;
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Host names that can only mean "this machine". */
const LOCAL_HOSTNAMES = Object.freeze(new Set(['127.0.0.1', 'localhost', '::1', '[::1]']));

function authorityOf(host) {
  const value = String(host ?? '').trim().toLowerCase();
  if (value === '') return '';
  const bracket = value.indexOf(']');
  if (value.startsWith('[') && bracket !== -1) return value.slice(0, bracket + 1);
  return value.split(':')[0];
}

/**
 * Fence for the same-origin state API.
 *
 * `isLoopbackRequest` alone is NOT enough: cloudflared forwards the tunnel to
 * `http://127.0.0.1:<port>`, so a request from the public internet also arrives
 * from a loopback socket. Three independent signals keep the panel API local:
 *
 *   1. tunnel headers (`cf-connecting-ip`, `x-forwarded-*`) are only ever added
 *      by the tunnel, never by a browser talking to the local web server;
 *   2. the `Host` authority must be a loopback name, because the bridge prefix is
 *      also reachable through the tunnel hostname;
 *   3. cross-site browser requests are refused, so a malicious page cannot drive
 *      `/api/pairing` with a no-cors POST (CSRF).
 *
 * A plain curl on loopback still passes: that is the same user who owns the
 * machine and the state directory.
 */
function isPanelRequest(req) {
  if (!isLoopbackRequest(req)) return false;
  for (const header of ['cf-connecting-ip', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-ray']) {
    if (String(req.headers[header] ?? '').trim() !== '') return false;
  }
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  const hostname = authorityOf(host);
  if (!LOCAL_HOSTNAMES.has(hostname)) return false;
  const site = String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = String(req.headers.origin ?? '').trim().toLowerCase();
  if (origin !== '') {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost !== host) return false;
  }
  return true;
}

export { createMcp };
/** Exported for tests: the fence that keeps the state API on this machine. */
export { isPanelRequest };
