// Hardware identity for license binding.
//
// What actually works on real machines (measured, not assumed):
//
//   HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid   stable per OS install,
//                                                      readable without admin
//   physical NIC MAC                                   stable per adapter
//   SMBIOS UUID                                        OFTEN a placeholder
//                                                      ("03000200-0400-..."),
//                                                      identical across boards
//   Win32_BaseBoard / Win32_BIOS serial                OFTEN "Default string"
//   Win32_Processor.ProcessorId                        identical for every CPU
//                                                      of one model
//
// So the code is built from the two signals that survived measurement: the
// MachineGuid and the set of physical MAC addresses. The SMBIOS UUID is used only
// when it is *not* one of the known placeholder patterns, as a bonus signal.
//
// Three hashes are derived, in decreasing strictness:
//
//   primary   guid + primary MAC      what the panel shows as the machine code
//   guidOnly  guid alone              survives a NIC swap / a disabled adapter;
//                                     shown as the recovery code
//   macOnly   MAC set alone           survives an OS reinstall on the same box
//
// A license may carry any of them. Matching is "any alias intersects", so a
// customer who changed a network card can be re-issued a key carrying the
// recovery code instead of a new machine.
//
// Everything is hashed with a domain separator before it leaves this module: the
// license never contains a raw MachineGuid or MAC, and a stolen license file
// reveals nothing that identifies the machine in another context.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { networkInterfaces, platform } from 'node:os';

/** Prefix mixed into every hash so these digests cannot collide with other uses. */
const DOMAIN = 'dshwcg/machine/v1';

/** OUIs owned by hypervisors; their MACs are per-boot noise, not identity. */
const VIRTUAL_OUI = Object.freeze([
  '00:15:5d', // Hyper-V / WSL
  '00:50:56', // VMware
  '00:0c:29', // VMware
  '08:00:27', // VirtualBox
  '00:1c:42', // Parallels
  '52:54:00', // QEMU / KVM
  '00:16:3e', // Xen
]);

/** SMBIOS UUIDs vendors ship when nobody programmed one. Never identity. */
const PLACEHOLDER_UUIDS = Object.freeze([
  '03000200-0400-0500-0006-000700080009',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '00020003-0004-0005-0006-000700080009',
]);

/** Cached MachineGuid: the registry read costs a process spawn, so do it once. */
let guidCache;
/** Cached SMBIOS UUID: reading it spawns PowerShell (~400 ms), so do it once. */
let uuidCache;

/**
 * Read the Windows MachineGuid without admin rights.
 * @returns {string} lowercase guid, or '' when unavailable (non-Windows, denied).
 */
function readMachineGuid() {
  if (guidCache !== undefined) return guidCache;
  guidCache = '';
  if (platform() !== 'win32') return guidCache;
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/MachineGuid\s+REG_\w+\s+([0-9a-fA-F-]{32,40})/);
    if (match !== null) guidCache = match[1].trim().toLowerCase();
  } catch {
    // Non-fatal: the MAC set alone still produces a usable code.
  }
  return guidCache;
}

/**
 * MAC addresses that plausibly belong to hardware, sorted and deduplicated.
 *
 * Filters, in order: empty, all-zero, the loopback/ignored entries, known
 * hypervisor OUIs, and every locally-administered address. That last filter is
 * what removes Bluetooth PAN (0a:…), Tailscale/WireGuard tunnels (random) and
 * Wi-Fi direct clones, which all change between boots.
 * @returns {string[]} lower-case colon-separated MACs.
 */
export function physicalMacs() {
  const found = new Set();
  let faces;
  try {
    faces = networkInterfaces();
  } catch {
    return [];
  }
  for (const list of Object.values(faces)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      if (entry.internal === true) continue;
      const mac = String(entry.mac ?? '').toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) continue;
      if (mac === '00:00:00:00:00:00') continue;
      if (VIRTUAL_OUI.includes(mac.slice(0, 8))) continue;
      // Locally administered bit: bit 1 of the first octet.
      if ((Number.parseInt(mac.slice(0, 2), 16) & 0x02) !== 0) continue;
      found.add(mac);
    }
  }
  return [...found].sort();
}

/**
 * SMBIOS UUID when the vendor actually programmed one.
 *
 * Deliberately NOT part of the fast identity path: reading it spawns PowerShell
 * (~400 ms) and it is a placeholder on most consumer boards. It is consulted only
 * when a license carries a `uuid` alias and everything cheaper already missed.
 * @returns {string} lowercase uuid, or '' when placeholder / unavailable.
 */
export function smbiosUuid() {
  if (uuidCache !== undefined) return uuidCache;
  uuidCache = '';
  if (platform() !== 'win32') return uuidCache;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystemProduct).UUID'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const uuid = String(out ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) return uuidCache;
    if (PLACEHOLDER_UUIDS.includes(uuid)) return uuidCache;
    uuidCache = uuid;
  } catch {
    // Non-fatal: the cheap signals already produced a code.
  }
  return uuidCache;
}

/** @param {string} input material @returns {string} 16 hex chars. */
function digest16(input) {
  return createHash('sha256').update(`${DOMAIN}|${String(input)}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Every cheap signal this machine offers. Signals that are empty are omitted so a
 * digest never depends on an absent value. The SMBIOS UUID is NOT included here —
 * see {@link machineIdentity} for why.
 * @returns {{guid: string, macs: string[]}} signals.
 */
export function machineSignals() {
  return { guid: readMachineGuid(), macs: physicalMacs() };
}

/** Group 16 hex chars as `DSH-XXXX-XXXX-XXXX-XXXX`. @param {string} hex @returns {string} */
export function formatMachineCode(hex) {
  const text = String(hex ?? '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 16);
  if (text.length !== 16) return '';
  return `DSH-${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}`;
}

/** Strip display formatting from a pasted machine code. @param {unknown} input @returns {string} */
export function parseMachineCode(input) {
  // Trim first: a pasted code often arrives with padding, and the `dsh` prefix
  // strip is anchored, so leading spaces would otherwise leave a stray `d`.
  const text = String(input ?? '').trim().toLowerCase().replace(/^dsh[-_\s]?/, '');
  const hex = text.replace(/[^0-9a-f]/g, '');
  // Partial matches are noise, not a code: "not-a-code" contains the hex letters
  // a, c, d, e, and calling that a machine code would bind a licence to nothing.
  return hex.length === 16 ? hex : '';
}

/**
 * The hardware identity of this machine, with all license-matching aliases.
 *
 * The default (`deep: false`) path touches only the registry and the interface
 * list — about 20 ms. `deep: true` additionally reads the SMBIOS UUID via
 * PowerShell (~400 ms), which is worth paying only when a cheap match already
 * failed and the license might have been bound to the UUID.
 * @param {{deep?: boolean}} [options] deep arm.
 * @returns {{code: string, display: string, aliases: string[], signals: object}} identity.
 */
export function machineIdentity(options = {}) {
  const deep = options?.deep === true;
  const signals = machineSignals();
  const primaryMac = signals.macs.length > 0 ? signals.macs[0] : '';
  const macSet = signals.macs.join(',');
  const uuid = deep ? smbiosUuid() : '';
  const parts = [signals.guid, primaryMac, uuid].filter((v) => v !== '');
  const primary = digest16(parts.length > 0 ? parts.join('|') : `fallback|${platform()}`);
  const aliases = new Set([primary]);
  if (signals.guid !== '') aliases.add(digest16(`${signals.guid}|guid`));
  if (macSet !== '') aliases.add(digest16(`${macSet}|macs`));
  if (uuid !== '') aliases.add(digest16(`${uuid}|uuid`));
  return {
    code: primary,
    display: formatMachineCode(primary),
    aliases: [...aliases],
    signals: {
      hasGuid: signals.guid !== '',
      macCount: signals.macs.length,
      hasUuid: uuid !== '',
    },
  };
}

/**
 * Does this machine match any hash listed in a license?
 *
 * Any-alias intersection: the license normally carries the primary code, but a
 * recovery code (`guidOnly` / `macOnly`) also matches when the customer's hardware
 * changed in the other direction.
 *
 * The cheap identity is tried first. Only when it misses AND the license does not
 * contain the primary/recovery digests we already know about does the deep identity
 * run — so a bound-and-matching license costs ~20 ms, and a licence that happens to
 * be bound to the SMBIOS UUID still verifies instead of being wrongly rejected.
 * @param {string[]} licensed hex hashes from the license payload.
 * @param {object} [identity] pre-computed identity (tests inject one).
 * @returns {boolean} true when this machine is licensed.
 */
export function machineMatches(licensed, identity = null) {
  if (!Array.isArray(licensed) || licensed.length === 0) return false;
  if (licensed.length > 16) return false;
  const wanted = [];
  for (const entry of licensed) {
    if (typeof entry !== 'string') continue;
    const hex = parseMachineCode(entry);
    if (hex !== '') wanted.push(hex);
  }
  if (wanted.length === 0) return false;
  const intersects = (aliases) => {
    const mine = new Set(aliases.map((a) => String(a).toLowerCase()));
    return wanted.some((hex) => mine.has(hex));
  };
  if (identity !== null) return intersects(identity.aliases);
  if (intersects(machineIdentity().aliases)) return true;
  return intersects(machineIdentity({ deep: true }).aliases);
}
