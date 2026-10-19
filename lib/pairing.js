// One-time pairing codes. A code is minted by the DSH panel and typed by the
// human into the browser page served by lib/oauth.js. That proves whoever is
// driving the browser also owns the machine running DSH. Codes are short lived,
// single use, limited per code and limited per client IP.
import crypto from 'node:crypto';

import { nowIso, timingSafeEqual } from './util.js';

// 31 symbols, no 0/O/1/I/L: a human can retype a code without guessing.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_IP_LIMIT = 10;
const DEFAULT_IP_WINDOW_MS = 10 * 60 * 1000;

function positiveNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInteger(value, fallback) {
  return Math.max(1, Math.trunc(positiveNumber(value, fallback)));
}

function emptyPairing() {
  return { code: null, createdAt: null, expiresAt: null, attempts: 0, consumed: false };
}

function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeCode(value) {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateCode() {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return code;
}

function snapshotPairing(store) {
  const record = store?.state?.pairing;
  if (!record || typeof record !== 'object') return emptyPairing();
  return {
    code: typeof record.code === 'string' && record.code !== '' ? record.code : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
    attempts: Number.isInteger(record.attempts) && record.attempts > 0 ? record.attempts : 0,
    consumed: record.consumed === true,
  };
}

function expired(record) {
  const expiresAtMs = Date.parse(record.expiresAt ?? '');
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now();
}

/**
 * Issues and verifies one-time pairing codes against `store.state.pairing`.
 *
 * Per-attempt limiting is split in two: a code locks after `maxAttempts` wrong
 * guesses and a single client IP locks after `ipLimit` wrong guesses within
 * `ipWindowMs` (the IP map is memory-only on purpose: it must not leak into the
 * persisted state file and it resets when the bridge restarts).
 */
export class PairingManager {
  /**
   * @param {object} options
   * @param {import('./state.js').StateStore} options.store write-through state store
   * @param {number} [options.ttlMs] how long an issued code stays valid
   * @param {number} [options.maxAttempts] wrong guesses allowed per code
   * @param {number} [options.ipLimit] wrong guesses allowed per IP inside the window
   * @param {number} [options.ipWindowMs] sliding window for the per-IP limit
   */
  constructor({ store, ttlMs = DEFAULT_TTL_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, ipLimit = DEFAULT_IP_LIMIT, ipWindowMs = DEFAULT_IP_WINDOW_MS } = {}) {
    if (!store || typeof store.update !== 'function') {
      const error = new Error('PairingManager requires a StateStore');
      error.code = 'INVALID_ARGS';
      throw error;
    }
    this.store = store;
    this.ttlMs = positiveNumber(ttlMs, DEFAULT_TTL_MS);
    this.maxAttempts = positiveInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.ipLimit = positiveInteger(ipLimit, DEFAULT_IP_LIMIT);
    this.ipWindowMs = positiveNumber(ipWindowMs, DEFAULT_IP_WINDOW_MS);
    /** @type {Map<string, number[]>} recent failure timestamps per client IP */
    this.ipFailures = new Map();
  }

  /** Mint a new code, replacing any previous one. @returns {Promise<{code:string, expiresAt:string, ttlMs:number}>} */
  async issue() {
    await this.store.init();
    const code = generateCode();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    await this.store.update((state) => {
      state.pairing = { code, createdAt, expiresAt, attempts: 0, consumed: false };
    });
    return { code: formatCode(code), expiresAt, ttlMs: this.ttlMs };
  }

  /**
   * Consume a code. The code is consumed only on success.
   * @param {object} input
   * @param {string} input.code code as typed (dashes, spaces and case are forgiving)
   * @param {string} [input.ip] client IP used for the per-IP rate limit
   * @returns {Promise<{ok:true} | {ok:false, reason:'EXPIRED'|'INVALID'|'LOCKED'|'CONSUMED'}>}
   */
  async claim({ code, ip } = {}) {
    await this.store.init();
    const normalized = normalizeCode(code);
    const ipKey = typeof ip === 'string' && ip.trim() !== '' ? ip.trim() : 'unknown';
    if (normalized === '') {
      this.#recordIpFailure(ipKey);
      return { ok: false, reason: 'INVALID' };
    }
    if (this.#ipLocked(ipKey)) return { ok: false, reason: 'LOCKED' };
    const outcome = await this.store.update((state) => {
      if (!state.pairing || typeof state.pairing !== 'object') state.pairing = emptyPairing();
      const record = state.pairing;
      if (!record.code) return { ok: false, reason: 'INVALID' };
      if (record.consumed === true) return { ok: false, reason: 'CONSUMED' };
      if (expired(record)) return { ok: false, reason: 'EXPIRED' };
      if ((record.attempts ?? 0) >= this.maxAttempts) return { ok: false, reason: 'LOCKED' };
      if (timingSafeEqual(normalized, record.code)) {
        record.consumed = true;
        return { ok: true };
      }
      record.attempts = (record.attempts ?? 0) + 1;
      return { ok: false, reason: 'INVALID' };
    });
    if (outcome.ok) this.ipFailures.delete(ipKey);
    else this.#recordIpFailure(ipKey);
    return outcome;
  }

  /** @returns {{active:boolean, code?:string, expiresAt?:string, attemptsLeft:number, locked:boolean}} */
  status() {
    const record = snapshotPairing(this.store);
    const expiresAtMs = Date.parse(record.expiresAt ?? '');
    const locked = record.attempts >= this.maxAttempts;
    const active = record.code !== null
      && record.consumed !== true
      && Number.isFinite(expiresAtMs)
      && expiresAtMs > Date.now()
      && !locked;
    const result = {
      active,
      attemptsLeft: Math.max(0, this.maxAttempts - record.attempts),
      locked,
    };
    if (record.code && !record.consumed) {
      result.code = formatCode(record.code);
      result.expiresAt = record.expiresAt;
    }
    return result;
  }

  /** Drop the current code and clear the in-memory IP counters. */
  async revoke() {
    await this.store.init();
    await this.store.update((state) => {
      state.pairing = emptyPairing();
    });
    this.ipFailures.clear();
    return { ok: true };
  }

  #recentFailures(ip) {
    const list = this.ipFailures.get(ip);
    if (!Array.isArray(list)) return [];
    const cutoff = Date.now() - this.ipWindowMs;
    const recent = list.filter((timestamp) => timestamp > cutoff);
    if (recent.length === 0) this.ipFailures.delete(ip);
    else if (recent.length !== list.length) this.ipFailures.set(ip, recent);
    return recent;
  }

  #ipLocked(ip) {
    return this.#recentFailures(ip).length >= this.ipLimit;
  }

  #recordIpFailure(ip) {
    const recent = this.#recentFailures(ip);
    recent.push(Date.now());
    const cap = this.ipLimit * 2;
    if (recent.length > cap) recent.splice(0, recent.length - cap);
    this.ipFailures.set(ip, recent);
  }
}
