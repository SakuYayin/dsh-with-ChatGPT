// Offline license gate.
//
// Design goals, in order:
//   1. no key material ships in the source — only scrypt hashes and a public key;
//   2. entering an arbitrary string never activates: only *issued* material does;
//   3. a licence is bound to hardware (see machine.js), so one key serves one
//      customer and at most SEATS machines;
//   4. the stored activation record is bound to this machine and integrity-tagged,
//      so copying the state directory to another machine does not transfer it;
//   5. guessing is expensive (scrypt) and slow (exponential backoff);
//   6. every check is constant-time where it compares secrets.
//
// Two accepted forms:
//
//   A. signed licence — `DSH1.<base64url(payload)>.<base64url(sig)>`, an Ed25519
//      signature over the payload by the seller's private key. THIS IS THE PAID
//      FORM: the payload names the customer and the machine codes the licence may
//      run on. The plugin only embeds the PUBLIC key, so issuing a key needs no
//      code change and the plugin cannot mint keys.
//   B. master key   — an 8+ character string whose scrypt hash is listed in
//      MASTER_HASHES. Developer/self key: it is not per-customer, so it is bound
//      only to whatever machine activates it first.
//
// What this cannot do: stop someone who edits the JavaScript. Offline licensing is
// tamper-*resistant*, not tamper-*proof*. The seat limit is enforced where the
// licence is *issued* (the seller's tool refuses a third machine) rather than at
// runtime, because an offline plugin has no way to count activations on machines it
// never hears from — that would need a server.

import { createHash, createHmac, createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { hostname, platform, arch } from 'node:os';
import { formatMachineCode, machineIdentity, machineMatches, parseMachineCode } from './machine.js';

/** Bump when the hash derivation changes; stored records are then re-prompted. */
export const LICENSE_VERSION = 2;

/**
 * Machines one licence may be bound to. A customer who replaces a PC asks the
 * seller for a re-issued key; the seller's tool refuses to put a third code in.
 */
export const MAX_SEATS = 2;

/** scrypt cost. 32768 * 8 * 128 = 32 MiB per attempt, ~60 ms on a desktop CPU. */
const KDF = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

/** Fixed application salt: domain separation, not secrecy. */
const APP_SALT = Buffer.from('dsh-with-chatgpt/license/v1', 'utf8');
/** Salt for the record integrity tag (different domain from the key hash). */
const MAC_SALT = Buffer.from('dsh-with-chatgpt/license/mac/v1', 'utf8');

/**
 * scrypt hashes of issued master keys, `hex(hash) -> { edition }`.
 *
 * These are one-way: recovering a key from one costs a full scrypt per guess, and
 * the hash itself cannot be replayed as a key (hashing a hash is not in the list).
 * Generate an entry with `node tools/mint-license.mjs --hash <key>`.
 */
export const MASTER_HASHES = Object.freeze({
  // Bootstrap key, edition "pro". The plaintext lives nowhere in this repository.
  cf09458448c96dfc3c1a57ebc18c57844d448d3e2151adbaee1277631e5e7ff2: Object.freeze({
    id: 'bootstrap',
    edition: 'pro',
    note: 'bootstrap master key',
  }),
});

/**
 * Ed25519 public key for signed licenses (SPKI PEM). The matching private key is
 * NOT in this repository — keep it offline (`node tools/mint-license.mjs --init`
 * creates one next to the checkout).
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAS3suie2a9BO7FJxPbb4coJEytoMZqYEc+Cdm+RSAff4=
-----END PUBLIC KEY-----`;

/** Short, stable id for a key hash: what the user sees and support asks for. */
function keyIdOf(hashHex) {
  return createHash('sha256').update(Buffer.from(hashHex, 'hex')).digest('hex').slice(0, 16);
}

/**
 * Normalize a pasted key: strip surrounding whitespace and invisible characters,
 * apply NFKC so full-width input matches. Never touches inner characters, so a
 * key containing spaces or `~` keeps them.
 * @param {unknown} input raw user input.
 * @returns {string} normalized key.
 */
export function normalizeKey(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .normalize('NFKC');
}

/**
 * Derive the verification hash for a key. Deliberately slow.
 * @param {string} key normalized key.
 * @returns {string} hex scrypt output.
 */
export function hashKey(key) {
  return scryptSync(key, APP_SALT, 32, KDF).toString('hex');
}

/** True when the string looks like a signed license blob (structural only). */
export function looksLikeSignedLicense(text) {
  return typeof text === 'string' && text.startsWith('DSH1.');
}

/** base64url decode that rejects anything non-canonical. @param {string} text @returns {Buffer|null} */
function decodeB64u(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
}

/**
 * Machine codes a signed licence is allowed to run on.
 *
 * The payload field is `m`: an array of at most {@link MAX_SEATS} 16-hex codes.
 * Older payloads without `m` are treated as "not machine-bound" — only the
 * developer's own key uses that shape.
 * @param {object} payload verified payload.
 * @returns {string[]} 16-hex machine codes, possibly empty.
 */
export function licenseMachines(payload) {
  const raw = payload !== null && typeof payload === 'object' ? payload.m ?? payload.machines : undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const hex = parseMachineCode(entry);
    if (hex !== '' && !out.includes(hex)) out.push(hex);
    if (out.length >= MAX_SEATS) break;
  }
  return out;
}

/**
 * Verify a signed license blob. Checks structure, signature, expiry — nothing else.
 * @param {string} text the `DSH1.…` blob.
 * @returns {{ok: boolean, reason?: string, payload?: object}} result.
 */
export function verifySignedLicense(text) {
  const parts = String(text).split('.');
  if (parts.length !== 3 || parts[0] !== 'DSH1') return { ok: false, reason: 'BAD_FORMAT' };
  const payloadBytes = decodeB64u(parts[1]);
  const signature = decodeB64u(parts[2]);
  if (payloadBytes === null || signature === null) return { ok: false, reason: 'BAD_FORMAT' };
  let publicKey;
  try {
    publicKey = createPublicKey(LICENSE_PUBLIC_KEY_PEM);
  } catch {
    return { ok: false, reason: 'NO_PUBLIC_KEY' };
  }
  let valid = false;
  try {
    valid = cryptoVerify(null, payloadBytes, publicKey, signature);
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }
  if (!valid) return { ok: false, reason: 'BAD_SIGNATURE' };
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'BAD_PAYLOAD' };
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'BAD_PAYLOAD' };
  const now = Date.now();
  if (typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp * 1000 < now) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (typeof payload.nbf === 'number' && Number.isFinite(payload.nbf) && payload.nbf * 1000 > now) {
    return { ok: false, reason: 'NOT_YET_VALID' };
  }
  return { ok: true, payload };
}

/**
 * Binding of the stored record to this machine.
 *
 * The hardware code from machine.js is the identity; the random install id keeps
 * two DSH profiles on one PC from sharing an activation record. A state directory
 * copied to another PC produces a different digest, so the record stops verifying.
 * @param {string} installId random hex persisted by the caller.
 * @returns {string} hex digest.
 */
export function machineBinding(installId) {
  const material = ['dshwcg/bind/v2', machineIdentity().code, hostname(), platform(), arch(), String(installId ?? '')].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Integrity tag over the stored record, keyed by the local machine. Any edit to the
 * record fields — edition, entryId, machine, seats — changes the tag and the license
 * is rejected on the next start.
 * @param {object} fields record fields.
 * @param {string} installId install identity.
 * @returns {string} hex hmac.
 */
function tagOf(fields, installId) {
  const key = scryptSync([hostname(), platform(), String(installId ?? '')].join('|'), MAC_SALT, 32, KDF);
  const message = [
    fields.v,
    fields.kind,
    fields.entryId,
    fields.edition,
    fields.machine,
    fields.activatedAt,
    String(fields.seats ?? ''),
    String(fields.customer ?? ''),
  ].join('|');
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

/** Constant-time compare of two hex strings; length mismatch is a plain false. */
function sameHex(a, b) {
  const left = Buffer.from(String(a ?? ''), 'hex');
  const right = Buffer.from(String(b ?? ''), 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Exponential delay after repeated failures, capped at one hour. */
function backoffUntil(attempts, now) {
  if (attempts < 3) return 0;
  const seconds = Math.min(3600, 2 ** Math.min(attempts - 2, 12));
  return now + seconds * 1000;
}

/**
 * The gate itself. Holds no key material: activation stores a machine-bound record
 * plus enough one-way material to re-verify without the key.
 */
export class LicenseManager {
  /**
   * @param {object} options
   * @param {object} options.store durable StateStore.
   * @param {object} [options.log] logger.
   */
  constructor({ store, log }) {
    this.store = store;
    this.log = log;
    /** @type {'active'|'inactive'|'invalid'|'expired'|'locked'} */
    this.state = 'inactive';
    this.edition = '';
    this.entryId = '';
    this.activatedAt = '';
    this.reason = '';
    this.lockedUntil = 0;
    this.activation = null;
    /** Customer name from a signed licence; '' for the master key. */
    this.customer = '';
    /** Machines the licence may run on (0 = not machine-limited). */
    this.seats = 0;
  }

  /** @returns {boolean} true when every gate should open. */
  get active() {
    return this.state === 'active';
  }

  /** Read the durable record and re-verify it. Never throws. */
  async init() {
    let record = null;
    try {
      record = this.store.state.license ?? null;
    } catch {
      record = null;
    }
    if (record === null || typeof record !== 'object') {
      this.state = 'inactive';
      this.reason = 'NOT_ACTIVATED';
      return this;
    }
    if (record.hash === undefined && record.blob === undefined && record.tag === undefined) {
      // Only the failure counter is stored: someone tried keys on a machine that was
      // never activated. That is "not activated", not "an outdated record" — and any
      // lockout it armed has to survive the restart, or guessing is free again after
      // every host restart.
      const failures = Math.max(0, Number(record.failures ?? 0));
      const lastFailureAt = Number(record.lastFailureAt ?? 0);
      if (failures > 0) {
        // No timestamp (older record): treat it as "just now" — the safe direction.
        this.lockedUntil = backoffUntil(failures, Number.isFinite(lastFailureAt) && lastFailureAt > 0 ? lastFailureAt : Date.now());
      }
      this.state = 'inactive';
      this.reason = 'NOT_ACTIVATED';
      return this;
    }
    if (Number(record.v) !== LICENSE_VERSION) {
      this.state = 'inactive';
      this.reason = 'RECORD_VERSION';
      return this;
    }
    const installId = this.installId();
    const expected = tagOf(
      {
        v: LICENSE_VERSION,
        kind: String(record.kind ?? ''),
        entryId: String(record.entryId ?? ''),
        edition: String(record.edition ?? ''),
        machine: String(record.machine ?? ''),
        activatedAt: String(record.activatedAt ?? ''),
        seats: Number(record.seats ?? 0),
        customer: String(record.customer ?? ''),
      },
      installId,
    );
    if (!sameHex(expected, record.tag)) {
      // Either the file was hand-edited or it came from another machine.
      this.state = 'invalid';
      this.reason = 'RECORD_TAMPERED';
      this.log?.warn?.('license record failed its integrity tag');
      return this;
    }
    const current = machineBinding(installId);
    if (!sameHex(current, record.machine)) {
      this.state = 'invalid';
      this.reason = 'MACHINE_MISMATCH';
      return this;
    }
    this.seats = Math.max(0, Number(record.seats ?? 0));
    this.customer = String(record.customer ?? '');
    if (record.kind === 'master') {
      if (!Object.prototype.hasOwnProperty.call(MASTER_HASHES, String(record.hash ?? ''))) {
        this.state = 'invalid';
        this.reason = 'UNKNOWN_KEY';
        return this;
      }
      this.state = 'active';
      this.reason = '';
      this.edition = String(record.edition ?? MASTER_HASHES[record.hash].edition ?? 'pro');
      this.entryId = String(record.entryId ?? '');
      this.activatedAt = String(record.activatedAt ?? '');
      return this;
    }
    if (record.kind === 'signed') {
      const blob = String(record.blob ?? '');
      const verified = verifySignedLicense(blob);
      if (!verified.ok) {
        this.state = verified.reason === 'EXPIRED' ? 'expired' : 'invalid';
        this.reason = String(verified.reason ?? 'BAD_SIGNATURE');
        return this;
      }
      // Re-check the hardware on every start: a licence blob copied to a second PC
      // verifies cryptographically but names machines this one is not.
      const allowed = licenseMachines(verified.payload);
      if (allowed.length > 0 && !machineMatches(allowed)) {
        this.state = 'invalid';
        this.reason = 'MACHINE_MISMATCH';
        this.log?.warn?.('license is bound to other machines');
        return this;
      }
      this.state = 'active';
      this.reason = '';
      this.edition = String(verified.payload.ed ?? 'pro');
      this.entryId = String(verified.payload.id ?? '');
      this.activatedAt = String(record.activatedAt ?? '');
      this.customer = String(verified.payload.name ?? '');
      this.seats = allowed.length;
      this.activation = verified.payload;
      return this;
    }
    this.state = 'inactive';
    this.reason = 'NOT_ACTIVATED';
    return this;
  }

  /** Per-install random identity; created once and kept in the state file. */
  installId() {
    const state = this.store.state;
    let id = typeof state.installId === 'string' ? state.installId : '';
    if (id === '') {
      id = randomBytes(16).toString('hex');
      state.installId = id;
      // Best effort: the next persist() call writes it. Activation persists anyway.
      void this.store.persist?.().catch?.(() => undefined);
    }
    return id;
  }

  /** Public status for the settings panel — never includes key material. */
  status() {
    const now = Date.now();
    const meta = this.activation === null || typeof this.activation !== 'object' ? null : this.activation;
    const identity = machineIdentity();
    const record = this.store.state.license ?? null;
    return {
      active: this.active,
      state: this.state,
      reason: this.reason,
      edition: this.edition,
      entryId: this.entryId,
      activatedAt: this.activatedAt,
      machineBound: this.state === 'active' || this.reason === 'MACHINE_MISMATCH',
      /** Full hardware code, `DSH-XXXX-XXXX-XXXX-XXXX` — what the customer sends the seller. */
      machineCode: identity.display,
      machineRecovery: formatMachineCode(identity.aliases[1] ?? ''),
      machineId: identity.code.slice(0, 16),
      lockedUntil: this.lockedUntil > now ? new Date(this.lockedUntil).toISOString() : null,
      attemptsLeft: Math.max(0, 5 - Number(record?.failures ?? 0)),
      customer: meta === null ? (this.customer || null) : String(meta.name ?? '') || null,
      /** How many machines this licence may be bound to; 0 = not limited. */
      seats: this.seats,
      maxSeats: MAX_SEATS,
      /** Machine codes the licence names, formatted for display. */
      licensedMachines: meta === null ? [] : licenseMachines(meta).map((hex) => formatMachineCode(hex)).filter((v) => v !== ''),
      expiresAt: meta === null || typeof meta.exp !== 'number' ? null : new Date(meta.exp * 1000).toISOString(),
      version: LICENSE_VERSION,
    };
  }

  /**
   * Try to activate with a pasted key or signed license.
   * @param {unknown} rawKey user input.
   * @returns {Promise<{ok: boolean, reason?: string, status: object}>} result.
   */
  async activate(rawKey) {
    const now = Date.now();
    if (this.lockedUntil > now) {
      return { ok: false, reason: 'LOCKED', status: this.status() };
    }
    const text = normalizeKey(rawKey);
    if (text === '') return { ok: false, reason: 'EMPTY', status: this.status() };

    let record = null;
    if (looksLikeSignedLicense(text)) {
      const verified = verifySignedLicense(text);
      if (!verified.ok) {
        await this.#recordFailure();
        return { ok: false, reason: String(verified.reason ?? 'BAD_SIGNATURE'), status: this.status() };
      }
      const payload = verified.payload;
      // The paid form is machine-bound: a blob that names other machines is a
      // copied licence, not a wrong key, so it counts as a failed attempt.
      const allowed = licenseMachines(payload);
      if (allowed.length > 0 && !machineMatches(allowed)) {
        await this.#recordFailure();
        return { ok: false, reason: 'MACHINE_MISMATCH', status: this.status() };
      }
      record = {
        kind: 'signed',
        blob: text,
        entryId: String(payload.id ?? ''),
        edition: String(payload.ed ?? 'pro'),
        seats: allowed.length,
        customer: String(payload.name ?? ''),
      };
    } else {
      if (text.length < 8) {
        await this.#recordFailure();
        return { ok: false, reason: 'TOO_SHORT', status: this.status() };
      }
      const hash = hashKey(text);
      const entry = MASTER_HASHES[hash];
      if (entry === undefined) {
        // A wrong key must not overwrite a *field* that survives into the next
        // status read: the persisted record keeps its failure counter, and the
        // returned reason is the one that explains this specific attempt.
        await this.#recordFailure();
        return { ok: false, reason: 'UNKNOWN_KEY', status: this.status() };
      }
      record = {
        kind: 'master',
        hash,
        entryId: keyIdOf(hash),
        edition: String(entry.edition ?? 'pro'),
      };
    }

    await this.#persistRecord(record);
    return { ok: this.state === 'active', reason: this.state === 'active' ? undefined : this.reason, status: this.status() };
  }

  /** Drop the activation (the customer asked to remove the license from this machine). */
  async deactivate() {
    const state = this.store.state;
    delete state.license;
    this.state = 'inactive';
    this.reason = 'NOT_ACTIVATED';
    this.edition = '';
    this.entryId = '';
    this.activatedAt = '';
    this.activation = null;
    await this.store.persist?.();
    return { ok: true, status: this.status() };
  }

  /** Count a failed attempt and arm backoff. */
  async #recordFailure() {
    const state = this.store.state;
    const license = state.license !== null && typeof state.license === 'object' ? state.license : {};
    const failures = Math.max(0, Number(license.failures ?? 0)) + 1;
    license.failures = failures;
    // Keep the moment of the last failure: backoff has to survive a restart, otherwise
    // restarting the host is a free way to reset the guess budget.
    license.lastFailureAt = Date.now();
    state.license = license;
    const until = backoffUntil(failures, Date.now());
    this.lockedUntil = until;
    if (until > 0) this.log?.warn?.(`license: ${failures} failed attempts, locked for ${Math.round((until - Date.now()) / 1000)}s`);
    await this.store.persist?.();
  }

  /** Write a fresh, machine-bound, integrity-tagged record. */
  async #persistRecord(record) {
    const installId = this.installId();
    const machine = machineBinding(installId);
    const activatedAt = new Date().toISOString();
    const fields = {
      v: LICENSE_VERSION,
      kind: record.kind,
      entryId: record.entryId,
      edition: record.edition,
      machine,
      activatedAt,
      seats: Math.max(0, Number(record.seats ?? 0)),
      customer: String(record.customer ?? ''),
    };
    const stored = {
      ...fields,
      hash: record.kind === 'master' ? record.hash : undefined,
      blob: record.kind === 'signed' ? record.blob : undefined,
      tag: tagOf(fields, installId),
      failures: 0,
    };
    this.store.state.license = stored;
    await this.store.persist?.();
    await this.init();
    this.log?.info?.(`license activated: ${this.edition} ${this.entryId}${fields.seats > 0 ? ` (${fields.seats} seat licence)` : ''}`);
  }
}

/** Machine-readable reason → what the user should do. Used by the tool and the panel. */
export const LICENSE_REASONS = Object.freeze({
  NOT_ACTIVATED: 'license required: enter your key in Settings → ChatGPT',
  EMPTY: 'enter a license key',
  TOO_SHORT: 'that key is too short to be a license',
  UNKNOWN_KEY: 'that key was not issued for this plugin',
  LOCKED: 'too many failed attempts — wait for the lockout to expire',
  BAD_FORMAT: 'that does not look like a license',
  BAD_SIGNATURE: 'the license signature is not valid',
  BAD_PAYLOAD: 'the license payload is unreadable',
  EXPIRED: 'this license has expired',
  NOT_YET_VALID: 'this license is not valid yet',
  RECORD_VERSION: 'the stored license is from an older version, enter the key again',
  RECORD_TAMPERED: 'the stored license was modified — enter the key again',
  MACHINE_MISMATCH: 'this license belongs to another machine',
  NO_PUBLIC_KEY: 'this build has no license public key',
});

/**
 * Human sentence for a reason code.
 * @param {string} reason code.
 * @returns {string} sentence.
 */
export function reasonText(reason) {
  return LICENSE_REASONS[String(reason ?? '')] ?? 'license check failed';
}
