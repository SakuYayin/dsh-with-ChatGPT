// Small shared helpers. Node built-ins only: this bundle must not depend on
// any @deepseek-ai package being resolvable from the plugin directory.
import crypto from 'node:crypto';
import path from 'node:path';

export const SERVER_NAME = 'dsh-with-chatgpt';
export const SERVER_VERSION = '0.1.0';

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(prefix, bytes = 8) {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`;
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function safeJsonParse(text, fallback = undefined) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ HTTP --- */

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  const payload = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

export function sendHtml(res, status, html, headers = {}) {
  sendText(res, status, html, 'text/html; charset=utf-8', headers);
}

export function sendEmpty(res, status, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end();
}

export function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        settled = true;
        const error = new Error(`request body exceeds ${limitBytes} bytes`);
        error.code = 'BODY_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

export async function readJsonBody(req, limitBytes) {
  const buffer = await readBody(req, limitBytes);
  if (buffer.length === 0) return undefined;
  const text = buffer.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('request body is not valid JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

export function requestUrl(req) {
  const host = req.headers.host || '127.0.0.1';
  return new URL(req.url || '/', `http://${host}`);
}

export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (value === '127.0.0.1' || value === '::1' || value === 'localhost') return true;
  return value.startsWith('127.');
}

export function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

/* --------------------------------------------------------------- helpers --- */

export const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
});

export function mimeOf(file) {
  return IMAGE_MIME[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

export function toPosix(value) {
  return String(value).split('\\').join('/');
}

export function truncate(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function bytesOf(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function redactSecrets(text) {
  let out = String(text ?? '');
  out = out.replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1 [REDACTED] $2');
  out = out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/g, '$1 [REDACTED]');
  out = out.replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED_TOKEN]');
  out = out.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=[REDACTED]');
  return out;
}

export function createLogger(tag, enabled = false) {
  const prefix = `[${tag}]`;
  return {
    debug: (...args) => {
      if (!enabled) return;
      // eslint-disable-next-line no-console
      console.log(prefix, ...args);
    },
    info: (...args) => {
      // eslint-disable-next-line no-console
      console.log(prefix, ...args);
    },
    warn: (...args) => {
      // eslint-disable-next-line no-console
      console.warn(prefix, ...args);
    },
    error: (...args) => {
      // eslint-disable-next-line no-console
      console.error(prefix, ...args);
    },
  };
}

export function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}
