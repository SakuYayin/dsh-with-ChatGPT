// Hardware identity: formatting round-trips, alias matching, and the placeholder
// filters that keep a shared mainboard UUID from becoming a shared licence.
//
// The last group is the one that matters commercially: a code bound to machine A
// must not match machine B, and the seller tool must refuse a third seat.

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  formatMachineCode,
  machineIdentity,
  machineMatches,
  parseMachineCode,
  physicalMacs,
  smbiosUuid,
} from '../lib/machine.js';
import { MAX_SEATS, licenseMachines } from '../lib/license.js';

const HEX = '258ce814a68ea9bd';

test('formatMachineCode groups 16 hex chars', () => {
  assert.equal(formatMachineCode(HEX), 'DSH-258c-e814-a68e-a9bd');
  assert.equal(formatMachineCode(HEX.toUpperCase()), 'DSH-258c-e814-a68e-a9bd');
  assert.equal(formatMachineCode(''), '');
  assert.equal(formatMachineCode('abc'), '', 'a short code is not a code');
});

test('parseMachineCode accepts the display form, the bare form and junk', () => {
  assert.equal(parseMachineCode('DSH-258c-e814-a68e-a9bd'), HEX);
  assert.equal(parseMachineCode('258ce814a68ea9bd'), HEX);
  assert.equal(parseMachineCode('dsh258c-e814-a68e-a9bd'), HEX);
  assert.equal(parseMachineCode('  DSH-258C-E814-A68E-A9BD  '), HEX);
  assert.equal(parseMachineCode('not-a-code'), '');
  assert.equal(parseMachineCode(null), '');
  assert.equal(parseMachineCode(42), '');
});

test('format and parse are inverses', () => {
  assert.equal(parseMachineCode(formatMachineCode(HEX)), HEX);
});

test('this machine has a stable code across calls', () => {
  const a = machineIdentity();
  const b = machineIdentity();
  assert.match(a.display, /^DSH-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(a.code, b.code, 'the code must not drift between calls');
  assert.ok(a.aliases.length >= 1);
  assert.ok(a.aliases.includes(a.code));
});

test('the deep identity only adds aliases, never changes the primary code', () => {
  const shallow = machineIdentity();
  const deep = machineIdentity({ deep: true });
  assert.equal(deep.code, shallow.code);
  assert.ok(deep.aliases.length >= shallow.aliases.length);
});

test('a placeholder SMBIOS UUID is filtered out', () => {
  // 03000200-… is what unfused mainboards report; treat it as absent.
  const uuid = smbiosUuid();
  assert.equal(uuid === '03000200-0400-0500-0006-000700080009', false);
});

test('physical MACs exclude virtual adapters and locally administered addresses', () => {
  for (const mac of physicalMacs()) {
    assert.match(mac, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
    const first = parseInt(mac.slice(0, 2), 16);
    assert.equal((first & 0x02) === 0, true, `${mac} must be a globally unique address`);
    const oui = mac.slice(0, 8);
    assert.equal(['00:15:5d', '00:50:56', '00:0c:29', '08:00:27', '00:1c:42', '52:54:00', '00:16:3e'].includes(oui), false);
  }
});

test('machineMatches accepts any alias and rejects foreign codes', () => {
  const identity = machineIdentity();
  assert.equal(machineMatches([identity.code], identity), true);
  for (const alias of identity.aliases) {
    assert.equal(machineMatches([alias], identity), true, `${alias} is an alias of this machine`);
  }
  assert.equal(machineMatches(['0000000000000000'], identity), false);
  assert.equal(machineMatches(['ffffffffffffffff'], identity), false);
});

test('machineMatches refuses empty, non-array and oversized input', () => {
  const identity = machineIdentity();
  assert.equal(machineMatches([], identity), false);
  assert.equal(machineMatches(null, identity), false);
  assert.equal(machineMatches('258ce814a68ea9bd', identity), false);
  const many = Array.from({ length: 17 }, (_, i) => String(i).padStart(16, '0'));
  assert.equal(machineMatches(many, identity), false, 'a 17-entry list is not a licence');
});

test('licenseMachines dedupes, caps at MAX_SEATS and drops bad entries', () => {
  const payload = {
    m: [
      'DSH-1111-1111-1111-1111',
      '2222222222222222',
      'DSH-1111-1111-1111-1111',
      'nonsense',
      'DSH-3333-3333-3333-3333',
    ],
  };
  const codes = licenseMachines(payload);
  assert.equal(codes.length, MAX_SEATS, 'a third distinct machine is truncated');
  assert.deepEqual(codes, ['1111111111111111', '2222222222222222']);
});

test('licenseMachines reads the `machines` spelling too and tolerates absence', () => {
  assert.deepEqual(licenseMachines({ machines: ['DSH-258c-e814-a68e-a9bd'] }), [HEX]);
  assert.deepEqual(licenseMachines({}), [], 'no machine list means not machine-bound');
  assert.deepEqual(licenseMachines(null), []);
  assert.deepEqual(licenseMachines({ m: [] }), []);
});

test('MAX_SEATS is two', () => {
  assert.equal(MAX_SEATS, 2);
});
