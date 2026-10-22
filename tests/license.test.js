// Offline license gate: activation, machine binding, tamper resistance, backoff.
//
// The property that matters most is the last group: an attacker who copies the
// state directory to another machine, or edits the stored record, must end up
// locked out again. Everything else is convenience around that.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHmac } from 'node:crypto';

import {
  LICENSE_VERSION,
  LicenseManager,
  MASTER_HASHES,
  hashKey,
  looksLikeSignedLicense,
  machineBinding,
  normalizeKey,
  reasonText,
  verifySignedLicense,
} from '../lib/license.js';

/** Minimal StateStore stand-in with the same surface LicenseManager touches. */
function fakeStore(initial = {}) {
  const store = {
    state: { ...initial },
    writes: 0,
    async persist() { store.writes += 1; },
    get session() { return store.state.session ?? {}; },
    async init() { return store; },
  };
  return store;
}

const GOOD_KEY = 'Yayin2004~';

test('the issued key hashes to a listed entry', () => {
  const hash = hashKey(GOOD_KEY);
  assert.ok(Object.prototype.hasOwnProperty.call(MASTER_HASHES, hash), 'hash must be in MASTER_HASHES');
  assert.equal(MASTER_HASHES[hash].edition, 'pro');
});

test('the good key does NOT appear in the source', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/license.js', import.meta.url), 'utf8');
  assert.equal(source.includes(GOOD_KEY), false, 'license.js must not contain the plaintext key');
});

test('normalizeKey strips invisible characters and trims', () => {
  assert.equal(normalizeKey('  Yayin2004~  '), 'Yayin2004~');
  assert.equal(normalizeKey('\u200BYayin2004~\uFEFF'), 'Yayin2004~');
  assert.equal(normalizeKey('Ｙａｙｉｎ２００４～'), 'Yayin2004~', 'NFKC folds full-width input');
  assert.equal(normalizeKey(null), '');
  assert.equal(normalizeKey(42), '');
});

test('a fresh install starts inactive and reports why', async () => {
  const manager = new LicenseManager({ store: fakeStore() });
  await manager.init();
  assert.equal(manager.active, false);
  assert.equal(manager.state, 'inactive');
  assert.equal(manager.reason, 'NOT_ACTIVATED');
  assert.equal(manager.status().message, undefined, 'status carries no message field');
  assert.match(reasonText(manager.reason), /license required/);
});

test('activation with the issued key succeeds and persists a machine-bound record', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  const result = await manager.activate(GOOD_KEY);
  assert.equal(result.ok, true, `expected activation, got ${result.reason}`);
  assert.equal(manager.active, true);
  assert.equal(manager.edition, 'pro');
  assert.equal(store.state.license.kind, 'master');
  assert.equal(store.state.license.hash, hashKey(GOOD_KEY));
  assert.equal(typeof store.state.license.tag, 'string');
  assert.equal(store.state.license.failures, 0);
  // The record must not contain the key or anything reversible to it.
  const serialized = JSON.stringify(store.state.license);
  assert.equal(serialized.includes(GOOD_KEY), false);
});

test('a reload re-verifies the record instead of trusting it', async () => {
  const store = fakeStore();
  const first = new LicenseManager({ store });
  await first.init();
  await first.activate(GOOD_KEY);
  const second = new LicenseManager({ store });
  await second.init();
  assert.equal(second.active, true);
  assert.equal(second.edition, 'pro');
});

test('an arbitrary key is rejected and never activates', async () => {
  // A fresh manager per attempt: repeated failures would arm the lockout and mask
  // the reason we are actually testing (UNKNOWN_KEY, not LOCKED).
  for (const bad of ['hunter2!!', 'Yayin2004', 'yayin2004~', 'x'.repeat(40), 'DSH1.fake.sig']) {
    const manager = new LicenseManager({ store: fakeStore() });
    await manager.init();
    const result = await manager.activate(bad);
    assert.equal(result.ok, false, `"${bad}" must not activate`);
    assert.equal(manager.active, false);
  }
});

test('empty and too-short input are named reasons', async () => {
  const manager = new LicenseManager({ store: fakeStore() });
  await manager.init();
  assert.equal((await manager.activate('')).reason, 'EMPTY');
  assert.equal((await manager.activate('abc')).reason, 'TOO_SHORT');
});

test('a record copied from another machine is rejected', async () => {
  const store = fakeStore();
  const first = new LicenseManager({ store });
  await first.init();
  await first.activate(GOOD_KEY);
  // Simulate a state directory moved to another machine: same file, new install id.
  store.state.installId = 'a'.repeat(32);
  const moved = new LicenseManager({ store });
  await moved.init();
  assert.equal(moved.active, false);
  assert.ok(['MACHINE_MISMATCH', 'RECORD_TAMPERED'].includes(moved.reason), `got ${moved.reason}`);
});

test('editing the stored edition breaks the integrity tag', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  await manager.activate(GOOD_KEY);
  store.state.license.edition = 'enterprise';
  const tampered = new LicenseManager({ store });
  await tampered.init();
  assert.equal(tampered.active, false);
  assert.equal(tampered.reason, 'RECORD_TAMPERED');
});

test('an unknown hash smuggled into the record does not activate', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  await manager.activate(GOOD_KEY);
  // Recompute a valid tag with a bogus hash: the tag check passes, the allowlist
  // check must still refuse. This is the "single patch cannot unlock everything" case.
  store.state.license.hash = 'f'.repeat(64);
  const { createHash } = await import('node:crypto');
  const scryptSync = (await import('node:crypto')).scryptSync;
  const { hostname, platform } = await import('node:os');
  const key = scryptSync([hostname(), platform(), store.state.installId].join('|'),
    Buffer.from('dsh-with-chatgpt/license/mac/v1', 'utf8'), 32,
    { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const fields = store.state.license;
  store.state.license.tag = createHmac('sha256', key).update(
    [fields.v, fields.kind, fields.entryId, fields.edition, fields.machine, fields.activatedAt].join('|'), 'utf8',
  ).digest('hex');
  const patched = new LicenseManager({ store });
  await patched.init();
  assert.equal(patched.active, false);
  assert.equal(patched.reason, 'UNKNOWN_KEY');
});

test('an unsupported record version asks for the key again', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  await manager.activate(GOOD_KEY);
  store.state.license.v = LICENSE_VERSION + 1;
  const upgraded = new LicenseManager({ store });
  await upgraded.init();
  assert.equal(upgraded.active, false);
  assert.equal(upgraded.reason, 'RECORD_VERSION');
});

test('deactivate clears the record', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  await manager.activate(GOOD_KEY);
  const result = await manager.deactivate();
  assert.equal(result.ok, true);
  assert.equal(manager.active, false);
  assert.equal(store.state.license, undefined);
});

test('failed attempts arm an exponential backoff', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await manager.activate('wrong-key-here');
    assert.equal(result.ok, false);
  }
  assert.equal(store.state.license.failures, 3);
  assert.ok(manager.lockedUntil > Date.now(), 'third failure must arm a lockout');
  const locked = await manager.activate(GOOD_KEY);
  assert.equal(locked.ok, false, 'a lockout rejects even the correct key');
  assert.equal(locked.reason, 'LOCKED');
});

test('a successful activation clears the failure count', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  await manager.activate('wrong-key-here');
  assert.equal(store.state.license.failures, 1);
  await manager.activate(GOOD_KEY);
  assert.equal(store.state.license.failures, 0);
});

test('status never exposes key material', async () => {
  const store = fakeStore();
  const manager = new LicenseManager({ store });
  await manager.init();
  await manager.activate(GOOD_KEY);
  const status = manager.status();
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(GOOD_KEY), false);
  assert.equal(serialized.includes(store.state.license.hash), false);
  assert.equal(serialized.includes(store.state.license.tag), false);
  assert.equal(status.machineId.length, 16);
  assert.equal(status.edition, 'pro');
});

test('machineBinding is stable for one install and changes with the install id', () => {
  assert.equal(machineBinding('abc'), machineBinding('abc'));
  assert.notEqual(machineBinding('abc'), machineBinding('abd'));
});

test('signed licenses: bad shapes are rejected without throwing', () => {
  for (const blob of ['', 'nope', 'DSH1.', 'DSH1.aaa', 'DSH1.aaa.bbb.ccc', 'DSH2.aaa.bbb']) {
    const result = verifySignedLicense(blob);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
  }
  assert.equal(looksLikeSignedLicense('DSH1.x.y'), true);
  assert.equal(looksLikeSignedLicense('Yayin2004~'), false);
});

test('a signed license with a forged signature is rejected', async () => {
  const payload = Buffer.from(JSON.stringify({ v: 1, id: 'lic_test', ed: 'pro' }), 'utf8');
  const forged = `DSH1.${payload.toString('base64url')}.${Buffer.alloc(64, 7).toString('base64url')}`;
  const result = verifySignedLicense(forged);
  assert.equal(result.ok, false);
  assert.ok(['BAD_SIGNATURE', 'NO_PUBLIC_KEY'].includes(result.reason), `got ${result.reason}`);
});

test('every reason code has a sentence', async () => {
  const { LICENSE_REASONS } = await import('../lib/license.js');
  for (const reason of Object.keys(LICENSE_REASONS)) {
    assert.notEqual(reasonText(reason), 'license check failed', `${reason} needs a sentence`);
  }
  assert.equal(reasonText('nonsense'), 'license check failed');
});

test('a record holding only a failure counter reads as NOT_ACTIVATED', async () => {
  // Happens on a machine that was never activated but did have keys tried on it.
  // Reporting RECORD_VERSION there would be a lie, and worse, it would look like a
  // compatibility problem instead of a wrong key.
  const store = fakeStore({ license: { failures: 2, lastFailureAt: Date.now() } });
  const manager = new LicenseManager({ store });
  await manager.init();
  assert.equal(manager.active, false);
  assert.equal(manager.reason, 'NOT_ACTIVATED');
  assert.equal(manager.status().attemptsLeft, 3);
});

test('a lockout survives a restart', async () => {
  // Restarting the host must not hand out a fresh guess budget.
  const store = fakeStore();
  const first = new LicenseManager({ store });
  await first.init();
  for (let attempt = 1; attempt <= 3; attempt += 1) await first.activate('wrong-key-here');
  assert.ok(first.lockedUntil > Date.now());

  const afterRestart = new LicenseManager({ store });
  await afterRestart.init();
  assert.ok(afterRestart.lockedUntil > Date.now(), 'the lockout must be restored from disk');
  assert.equal(afterRestart.status().lockedUntil !== null, true);
  const attempt = await afterRestart.activate(GOOD_KEY);
  assert.equal(attempt.ok, false);
  assert.equal(attempt.reason, 'LOCKED');
});

test('an expired lockout does not block a correct key forever', async () => {
  const longAgo = Date.now() - 3 * 60 * 60 * 1000;
  const store = fakeStore({ license: { failures: 3, lastFailureAt: longAgo } });
  const manager = new LicenseManager({ store });
  await manager.init();
  assert.equal(manager.status().lockedUntil, null, 'a stale lockout must have expired');
  const result = await manager.activate(GOOD_KEY);
  assert.equal(result.ok, true);
});
