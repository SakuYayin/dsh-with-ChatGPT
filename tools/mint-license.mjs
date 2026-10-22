#!/usr/bin/env node
// Licence key tooling — seller side only. Never ships to customers.
//
//   node tools/mint-license.mjs --machine                       print THIS machine's code
//   node tools/mint-license.mjs --hash 'Yayin2004~'             print a MASTER_HASHES entry
//   node tools/mint-license.mjs --mint --name '张三' \
//        --machine DSH-258c-e814-a68e-a9bd[,DSH-…]              issue a one-off paid licence
//   node tools/mint-license.mjs --verify 'DSH1.…'               check a blob
//   node tools/mint-license.mjs --inspect 'DSH1.…'              show who / which machines
//   node tools/mint-license.mjs --init                          create the signing key pair
//
// One customer, one key, at most MAX_SEATS (2) machines: `--mint` refuses a third
// machine code, so the limit is enforced at issue time — an offline plugin cannot
// count activations on machines it never hears from.
//
// The signing key lives OUTSIDE the repository:
//   $DSH_HOME/dsh-with-chatgpt-private.pem   (PKCS#8, mode 0600)
// A leaked private key lets anyone mint licences, so keep it in a password manager
// and copy it here only when you need to issue a key.

import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  LICENSE_VERSION,
  MAX_SEATS,
  hashKey,
  licenseMachines,
  normalizeKey,
  verifySignedLicense,
} from '../lib/license.js';
import { formatMachineCode, machineIdentity, parseMachineCode } from '../lib/machine.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

const PRIVATE_KEY_PATH = process.env.DSH_LICENSE_KEY
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-with-chatgpt-private.pem');

/**
 * Parse `--machine` into at most MAX_SEATS 16-hex codes.
 * Accepts `DSH-xxxx-…`, bare hex, and comma/space separated lists.
 * @param {string} raw CLI value.
 * @returns {{codes: string[], bad: string[]}} parsed codes and rejected entries.
 */
function parseMachines(raw) {
  const codes = [];
  const bad = [];
  for (const token of String(raw ?? '').split(/[,\s]+/)) {
    const text = token.trim();
    if (text === '') continue;
    const hex = parseMachineCode(text);
    if (hex.length !== 16) {
      bad.push(text);
      continue;
    }
    if (!codes.includes(hex)) codes.push(hex);
  }
  return { codes, bad };
}

// `--machine` doubles as the argument of `--mint`, so it only acts standalone.
if (has('machine') && !has('mint')) {
  const identity = machineIdentity({ deep: true });
  console.log(JSON.stringify({
    machineCode: identity.display,
    recoveryCode: formatMachineCode(identity.aliases[1] ?? ''),
    macRecoveryCode: formatMachineCode(identity.aliases[2] ?? ''),
    signals: identity.signals,
  }, null, 2));
  process.exit(0);
}

if (has('hash')) {
  const key = normalizeKey(value('hash'));
  if (key === '') {
    console.error('usage: --hash <key>');
    process.exit(1);
  }
  const hash = hashKey(key);
  const entryId = createHash('sha256').update(Buffer.from(hash, 'hex')).digest('hex').slice(0, 16);
  console.log(JSON.stringify({ hash, entryId }, null, 2));
  process.exit(0);
}

if (has('verify')) {
  const result = verifySignedLicense(value('verify'));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (has('inspect')) {
  const result = verifySignedLicense(value('inspect'));
  if (!result.ok) {
    console.error(`invalid: ${result.reason}`);
    process.exit(1);
  }
  const payload = result.payload;
  const machines = licenseMachines(payload);
  console.log(JSON.stringify({
    valid: true,
    id: payload.id ?? '',
    customer: payload.name ?? '',
    edition: payload.ed ?? '',
    issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : '',
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : 'never (perpetual)',
    seats: machines.length,
    maxSeats: MAX_SEATS,
    machines: machines.map((hex) => formatMachineCode(hex)),
  }, null, 2));
  process.exit(0);
}

if (has('mint')) {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    console.error(`private key not found: ${PRIVATE_KEY_PATH}`);
    console.error('generate one with: node tools/mint-license.mjs --init');
    process.exit(1);
  }
  const name = String(value('name', '')).trim();
  if (name === '') {
    console.error('--mint needs --name <customer> — one licence maps to one customer');
    process.exit(1);
  }
  const parsed = parseMachines(value('machine'));
  if (parsed.bad.length > 0) {
    console.error(`not a machine code: ${parsed.bad.join(', ')}`);
    console.error('ask the customer for the code shown in Settings → ChatGPT, or run --machine on their PC');
    process.exit(1);
  }
  if (parsed.codes.length === 0) {
    console.error('--mint needs --machine <code>[,<code>] — a paid licence must name its machines');
    console.error(`at most ${MAX_SEATS} codes; get one with: node tools/mint-license.mjs --machine`);
    process.exit(1);
  }
  if (parsed.codes.length > MAX_SEATS) {
    console.error(`a licence may name at most ${MAX_SEATS} machines, got ${parsed.codes.length}`);
    process.exit(1);
  }
  const days = Number(value('days', '0'));
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: LICENSE_VERSION,
    id: value('id', `lic_${randomBytes(5).toString('hex')}`),
    name,
    ed: value('edition', 'pro'),
    iat: now,
    m: parsed.codes,
  };
  // One-off purchase by default: no `exp` means perpetual. `--days` is only for
  // trials or subscriptions; a bought licence must not carry an expiry.
  if (Number.isFinite(days) && days > 0) payload.exp = now + days * 86400;
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, bytes, createPrivateKey(readFileSync(PRIVATE_KEY_PATH)));
  const blob = `DSH1.${bytes.toString('base64url')}.${signature.toString('base64url')}`;
  console.log(blob);
  console.error(`issued ${payload.id} for ${name}, ${parsed.codes.length}/${MAX_SEATS} seat(s): ${parsed.codes.map((hex) => formatMachineCode(hex)).join(' ')}`);
  process.exit(0);
}

if (has('init')) {
  const { generateKeyPairSync } = await import('node:crypto');
  const { writeFileSync } = await import('node:fs');
  if (existsSync(PRIVATE_KEY_PATH)) {
    console.error(`refusing to overwrite ${PRIVATE_KEY_PATH}`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(PRIVATE_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
  console.error(`private key written to ${PRIVATE_KEY_PATH}`);
  process.exit(0);
}

console.error(`usage:
  --machine                          print this machine's code (send it to the seller)
  --hash <key>                       print the MASTER_HASHES entry for a key
  --init                             generate a signing key pair (prints the public key)
  --mint --name <n> --machine <code>[,<code>] [--edition pro] [--days <n>] [--id <id>]
                                     issue a licence; at most ${MAX_SEATS} machine codes
  --verify  <DSH1.…>                 check that a blob is authentic
  --inspect <DSH1.…>                 show customer, seats and machines`);
process.exit(1);
