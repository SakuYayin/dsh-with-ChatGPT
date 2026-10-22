#!/usr/bin/env node
// License key tooling — seller side only. Never ships to customers.
//
//   node tools/mint-license.mjs --hash 'Yayin2004~'      print a MASTER_HASHES entry
//   node tools/mint-license.mjs --mint --name '张三' --edition pro [--days 365]
//   node tools/mint-license.mjs --verify 'DSH1.…'        check a blob
//
// The signing key lives OUTSIDE the repository:
//   $DSH_HOME/dsh-with-chatgpt-private.pem   (PKCS#8, mode 0600)
// A leaked private key lets anyone mint licenses, so keep it in a password manager
// and copy it here only when you need to issue a key.

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MASTER_HASHES, hashKey, normalizeKey, verifySignedLicense } from '../lib/license.js';

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
};

const PRIVATE_KEY_PATH = process.env.DSH_LICENSE_KEY
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-with-chatgpt-private.pem');

if (has('hash')) {
  const key = normalizeKey(value('hash'));
  if (key === '') {
    console.error('usage: --hash <key>');
    process.exit(1);
  }
  const hash = hashKey(key);
  const entryId = createHash('sha256').update(Buffer.from(hash, 'hex')).digest('hex').slice(0, 16);
  const known = MASTER_HASHES[hash];
  console.log(JSON.stringify({ hash, entryId, known: known ?? null }, null, 2));
  process.exit(0);
}

if (has('verify')) {
  const result = verifySignedLicense(value('verify'));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (has('mint')) {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    console.error(`private key not found: ${PRIVATE_KEY_PATH}`);
    console.error('generate one with: node tools/mint-license.mjs --init');
    process.exit(1);
  }
  const days = Number(value('days', '0'));
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    id: value('id', `lic_${createHash('sha256').update(String(now)).digest('hex').slice(0, 12)}`),
    name: value('name', ''),
    ed: value('edition', 'pro'),
    iat: now,
  };
  if (days > 0) payload.exp = now + days * 86400;
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, bytes, createPrivateKey(readFileSync(PRIVATE_KEY_PATH)));
  const blob = `DSH1.${bytes.toString('base64url')}.${signature.toString('base64url')}`;
  console.log(blob);
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
  --hash <key>                       print the MASTER_HASHES entry for a key
  --init                             generate a signing key pair (prints the public key)
  --mint --name <n> --edition <e> [--days <n>] [--id <id>]
  --verify <DSH1.…>                  check a signed license`);
process.exit(1);
