// Read-only, contained access to the user workspace for the ChatGPT bridge.
// Node built-ins only: this bundle is linked into a DSH profile where no npm
// dependency resolves. Nothing in this module ever writes to the workspace:
// every exported entry point is a pure read (listings, file reads, searches and
// read-only git queries).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { bytesOf, clampInt, safeJsonParse, stripBom, toPosix, truncate } from './util.js';

const IS_WINDOWS = process.platform === 'win32';
const SEARCH_TEXT_MAX = 400;
const MAX_QUERY_LENGTH = 500;
const MAX_GLOB_LENGTH = 300;
const RG_PROBE_CACHE = new Map();

/**
 * Default resource limits for a workspace instance. Every key is optional when
 * `Workspace.create({ root, limits })` is called; unknown keys are ignored.
 *
 * - allowSensitive: expose files on the sensitive deny list (default false).
 * - maxReadBytes: hard cap for `readFile` content (default 128 KiB).
 * - maxScanBytes: `readFile` scans at most this many bytes to count lines when
 *   the requested window fits; larger files report `totalLines: -1` (default 8 MiB).
 * - maxImageBytes: hard cap for `readImage` (default 4 MiB).
 * - maxDiffBytes: hard cap for `gitDiff` content (default 96 KiB).
 * - maxListEntries: `listDirectory` stops scanning after this many entries.
 * - maxGitEntries: `gitStatus` stops after this many entries.
 * - searchMaxFiles / searchMaxFileBytes / searchMaxMatches: Node search fallback bounds.
 * - useRipgrep: set false to always use the bounded Node walk.
 * - rgPath: explicit ripgrep executable; defaults to `rg` on PATH.
 * - rgTimeoutMs / gitTimeoutMs: subprocess timeouts.
 *
 * @type {Readonly<object>}
 */
export const DEFAULT_LIMITS = Object.freeze({
  allowSensitive: false,
  maxReadBytes: 128 * 1024,
  maxScanBytes: 8 * 1024 * 1024,
  maxImageBytes: 4 * 1024 * 1024,
  maxDiffBytes: 96 * 1024,
  maxListEntries: 5000,
  maxGitEntries: 2000,
  searchMaxFiles: 5000,
  searchMaxFileBytes: 2 * 1024 * 1024,
  searchMaxMatches: 2000,
  useRipgrep: true,
  rgPath: null,
  rgTimeoutMs: 20000,
  gitTimeoutMs: 15000,
});

/* ----------------------------------------------------------------- errors --- */

function workspaceError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) error[key] = value;
  }
  return error;
}

/** @param {string} message @returns {Error} */
function invalidArgs(message) {
  return workspaceError('INVALID_ARGS', message);
}

/** @param {string} candidate @returns {Error} */
function notFound(candidate) {
  return workspaceError('NOT_FOUND', `path not found: ${truncate(candidate, 200)}`, {
    path: truncate(String(candidate), 500),
  });
}

/** @param {string} candidate @returns {Error} */
function pathEscape(candidate) {
  return workspaceError('PATH_ESCAPE', `path escapes the workspace: ${truncate(candidate, 200)}`, {
    path: truncate(String(candidate), 500),
  });
}

/** @param {string} relativePath @returns {Error} */
function sensitiveFile(relativePath) {
  return workspaceError('SENSITIVE_FILE', `refusing to expose sensitive file: ${truncate(relativePath, 200)}`, {
    path: truncate(String(relativePath), 500),
  });
}

/* ------------------------------------------------------------ sensitivity --- */

const SENSITIVE_BASENAMES = new Set(['.env', '.npmrc', '.netrc', 'credentials.json']);
const SENSITIVE_ENV_ALLOWED = new Set(['.env.example', '.env.sample']);
const SENSITIVE_NAME_PREFIXES = Object.freeze(['id_rsa', 'id_ed25519', 'id_ecdsa']);
const SENSITIVE_SUFFIXES = Object.freeze(['.pem', '.key', '.p12', '.pfx', '.kdbx']);
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg']);
const WINDOWS_RESERVED_STEMS = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

/**
 * Windows path segments are matched after lowercasing, stripping NTFS trailing
 * dots/spaces and cutting alternate-data-stream suffixes (`file.txt:secret`).
 * @param {string} segment
 * @returns {string}
 */
function normalizeSegment(segment) {
  let value = String(segment).toLowerCase();
  if (IS_WINDOWS) {
    const streamIndex = value.indexOf(':');
    if (streamIndex !== -1) value = value.slice(0, streamIndex);
    value = value.replace(/[. ]+$/, '');
  }
  return value;
}

/**
 * True when a workspace-relative path names a credential-like file. Pure and
 * case-insensitive (defensively so on every platform). Missing trailing dots and
 * NTFS alternate data streams are folded away so `.env.` and `.env:stream`
 * cannot slip past the deny list on Windows.
 *
 * @param {string} relPath workspace-relative path, either separator style
 * @returns {boolean}
 */
export function isSensitivePath(relPath) {
  const normalized = toPosix(String(relPath ?? '')).replace(/^\.\//, '');
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return false;
  const lowered = segments.map(normalizeSegment);
  const base = lowered[lowered.length - 1];
  for (const segment of lowered) {
    if (SENSITIVE_DIRECTORIES.has(segment)) return true;
  }
  for (let index = 0; index < lowered.length - 1; index += 1) {
    if (lowered[index] === '.git' && lowered[index + 1] === 'config') return true;
  }
  if (SENSITIVE_ENV_ALLOWED.has(base)) return false;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  for (const prefix of SENSITIVE_NAME_PREFIXES) {
    if (base.startsWith(prefix)) return true;
  }
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  return false;
}

/* ----------------------------------------------------------- containment --- */

// Node's JS realpath does not resolve Windows junction points / reparse points;
// the native one does. Using the JS variant here would let a junction inside the
// workspace point anywhere on disk and still look contained, so the containment
// check always goes through this wrapper.
const realpathOptions = {};

/**
 * Resolve a path to its real location, following Windows junctions/reparse
 * points as well as symlinks.
 * @param {string} target
 * @returns {Promise<string>}
 */
function realpathNativeAsync(target) {
  return new Promise((resolve, reject) => {
    fs.realpath.native(target, realpathOptions, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}

/**
 * Synchronous counterpart of {@link realpathNativeAsync}.
 * @param {string} target
 * @returns {string}
 */
function realpathNativeSync(target) {
  return fs.realpathSync.native(target);
}

/** @param {string} root @returns {string} */
function validateRootInput(root) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw workspaceError('INVALID_WORKSPACE', 'workspace root must be a non-empty string');
  }
  return path.resolve(root);
}

/** @param {string} root @returns {Promise<string>} */
async function toRealRootAsync(root) {
  const absolute = validateRootInput(root);
  let real;
  try {
    real = await realpathNativeAsync(absolute);
  } catch (error) {
    throw workspaceError('INVALID_WORKSPACE', `workspace root is not accessible (${error?.code ?? 'ERROR'})`);
  }
  const stats = await fsp.stat(real).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw workspaceError('INVALID_WORKSPACE', 'workspace root is not a directory');
  }
  return real;
}

/** @param {string} root @returns {string} */
function toRealRootSync(root) {
  const absolute = validateRootInput(root);
  let real;
  try {
    real = realpathNativeSync(absolute);
  } catch (error) {
    throw workspaceError('INVALID_WORKSPACE', `workspace root is not accessible (${error?.code ?? 'ERROR'})`);
  }
  let stats;
  try {
    stats = fs.statSync(real);
  } catch {
    throw workspaceError('INVALID_WORKSPACE', 'workspace root is not accessible');
  }
  if (!stats.isDirectory()) throw workspaceError('INVALID_WORKSPACE', 'workspace root is not a directory');
  return real;
}

/**
 * Relative path of `absolute` from `realRoot`, POSIX-style; `null` when the path
 * is outside the root. Compares case-insensitively on Windows.
 * @param {string} realRoot
 * @param {string} absolute
 * @returns {string | null}
 */
function relativeOf(realRoot, absolute) {
  const root = IS_WINDOWS ? realRoot.toLowerCase() : realRoot;
  const target = IS_WINDOWS ? absolute.toLowerCase() : absolute;
  if (target === root) return '.';
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(prefix)) return null;
  const relative = absolute.slice(prefix.length);
  return toPosix(relative) || '.';
}

/** @param {string} candidate @returns {boolean} */
function hasReservedWindowsSegment(candidate) {
  const segments = String(candidate).split(/[\\/]+/);
  for (const segment of segments) {
    if (segment === '') continue;
    const name = segment.split(':')[0].replace(/[. ]+$/, '');
    const stem = name.split('.')[0].toLowerCase();
    if (WINDOWS_RESERVED_STEMS.has(stem)) return true;
  }
  return false;
}

/**
 * Resolve the deepest existing ancestor with realpath and re-append the
 * nonexistent tail. Symlinks anywhere in the existing prefix are resolved, so a
 * link pointing outside the workspace is caught by the caller's containment
 * check. A dangling symlink is left lexically in place: opening it fails with
 * NOT_FOUND, which is safe.
 * @param {string} resolved absolute path
 * @returns {string} real absolute path
 */
function materializeReal(resolved) {
  const tail = [];
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let realExisting;
  try {
    realExisting = realpathNativeSync(current);
  } catch (error) {
    throw workspaceError('NOT_FOUND', `path is not accessible (${error?.code ?? 'ERROR'})`);
  }
  return tail.length === 0 ? realExisting : path.resolve(realExisting, ...tail);
}

/**
 * Resolve `candidate` against `root`, enforce containment and the sensitive-file
 * deny list. Throws `{ code: 'PATH_ESCAPE' }`, `{ code: 'SENSITIVE_FILE' }`,
 * `{ code: 'INVALID_ARGS' }` or `{ code: 'INVALID_WORKSPACE' }`.
 *
 * Absolute candidates should already be written in the root's realpath form;
 * paths reached through a symlinked alias of the root are rejected as escapes.
 *
 * @param {string} root workspace root (absolute or relative)
 * @param {string} candidate workspace-relative or contained absolute path
 * @returns {string} absolute real path inside the workspace
 */
export function resolveInWorkspace(root, candidate) {
  return resolveContained(root, candidate, { allowSensitive: false });
}

/**
 * @param {string} root
 * @param {string} candidate
 * @param {{ allowSensitive?: boolean }} options
 * @returns {string}
 */
function resolveContained(root, candidate, { allowSensitive = false } = {}) {
  const realRoot = toRealRootSync(root);
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw invalidArgs('path must be a non-empty string');
  }
  if (candidate.includes('\0')) throw invalidArgs('path must not contain NUL bytes');
  if (IS_WINDOWS && hasReservedWindowsSegment(candidate)) {
    throw invalidArgs(`path uses a reserved Windows device name: ${truncate(candidate, 200)}`);
  }
  let resolved;
  try {
    resolved = path.resolve(realRoot, candidate);
  } catch {
    throw invalidArgs(`invalid path: ${truncate(candidate, 200)}`);
  }
  if (relativeOf(realRoot, resolved) === null) throw pathEscape(candidate);
  const realResolved = materializeReal(resolved);
  const relativePath = relativeOf(realRoot, realResolved);
  if (relativePath === null) throw pathEscape(candidate);
  if (!allowSensitive && isSensitivePath(relativePath)) throw sensitiveFile(relativePath);
  return realResolved;
}

/* ---------------------------------------------------------------- ignore --- */

/**
 * Convert one glob segment (no `/`) to a regular expression source.
 * @param {string} segment
 * @returns {string}
 */
function segmentToRegex(segment) {
  let out = '';
  for (const char of segment) {
    if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return out;
}

/**
 * Convert a `/`-separated glob into a regular expression source (`**` crosses
 * segments).
 * @param {string} pattern
 * @returns {string}
 */
function segmentsToRegex(pattern) {
  const segments = String(pattern).split('/');
  let out = '';
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === '**') {
      out += isLast ? '.*' : '(?:[^/]+/)*';
      return;
    }
    out += segmentToRegex(segment);
    if (!isLast) out += '/';
  });
  return out;
}

/**
 * Parse a `.c2cignore` document into ordered gitignore-ish rules.
 * Supports blank lines, `#` comments, `!` negation, `dir/` suffixes, root
 * anchoring with a leading `/`, and `*` / `**` / `?` globs.
 * @param {string} text
 * @returns {Array<{ negated: boolean, dirOnly: boolean, regex: RegExp }>}
 */
function parseIgnoreRules(text) {
  const rules = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (line === '') continue;
    let anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (line === '') continue;
    if (line.includes('/')) anchored = true;
    let regex;
    try {
      const body = segmentsToRegex(line);
      regex = anchored ? new RegExp(`^${body}$`) : new RegExp(`^(?:.*/)?${body}$`);
    } catch {
      continue;
    }
    rules.push({ negated, dirOnly, regex });
  }
  return rules;
}

/**
 * @param {{ dirOnly: boolean, regex: RegExp }} rule
 * @param {string} relPath
 * @returns {boolean}
 */
function ruleMatches(rule, relPath) {
  let value = toPosix(String(relPath ?? '')).replace(/^\/+/, '');
  const isDirHint = value.endsWith('/');
  value = value.replace(/\/+$/, '');
  if (value === '' || value === '.') return false;
  const parts = value.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const prefix = parts.slice(0, index).join('/');
    if (!rule.regex.test(prefix)) continue;
    // A `dir/` rule can only be proven for a strict ancestor, or when the
    // caller marked the path as a directory with a trailing slash.
    if (rule.dirOnly && index === parts.length && !isDirHint) continue;
    return true;
  }
  return false;
}

/**
 * Test a path against ordered ignore rules; the last matching rule wins, so
 * later `!` negations can re-include earlier matches.
 * @param {Array<{ negated: boolean, dirOnly: boolean, regex: RegExp }>} rules
 * @param {string} relPath
 * @returns {boolean}
 */
function matchesIgnoreRules(rules, relPath) {
  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, relPath)) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Load `<root>/.c2cignore` and return an async predicate: `true` means ignored.
 * A missing or unreadable ignore file yields a predicate that never ignores;
 * directory rules match when the path is passed with a trailing `/`.
 *
 * @param {string} root workspace root
 * @returns {Promise<(relPath: string) => Promise<boolean>>}
 */
export async function loadIgnoreMatcher(root) {
  let text = '';
  try {
    text = await fsp.readFile(path.join(path.resolve(String(root ?? '')), '.c2cignore'), 'utf8');
  } catch {
    text = '';
  }
  const rules = parseIgnoreRules(text);
  return async (relPath) => matchesIgnoreRules(rules, relPath);
}

/** Directories that are always skipped unless explicitly requested. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

/**
 * @param {string} relPath
 * @returns {boolean}
 */
function isDefaultSkipped(relPath) {
  const segments = toPosix(String(relPath ?? '')).split('/');
  return segments.some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

/* --------------------------------------------------------------- process --- */

/**
 * Read at most `max` bytes from a file, reporting whether more remained.
 * @param {string} file
 * @param {number} max
 * @returns {{ buffer: Buffer, truncated: boolean }}
 */
function readBoundedFile(file, max) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const stats = fs.fstatSync(fd);
    const size = Math.min(stats.size, max);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const bytes = fs.readSync(fd, buffer, read, size - read, read);
      if (bytes <= 0) break;
      read += bytes;
    }
    return { buffer: read === size ? buffer : buffer.subarray(0, read), truncated: stats.size > max };
  } catch {
    return { buffer: Buffer.alloc(0), truncated: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Run a subprocess and capture bounded stdout. Never rejects: spawn failures,
 * timeouts and truncation are reported in the resolved object.
 *
 * Output is redirected to files in the OS temp directory rather than piped: a
 * confined harness (DSH's Windows sandbox, some CI runners) refuses to create
 * the pipes `spawn` would otherwise need and fails the whole call with EPERM.
 * Redirected descriptors are plain file handles and work in those environments.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, maxBytes?: number, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, code: number | null, signal: NodeJS.Signals | null, stdout: Buffer, stderr: string, truncated: boolean, timedOut: boolean, error: Error | null }>}
 */
function runProcess(file, args, { cwd, env, maxBytes = 256 * 1024, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let tempDir = null;
    let outFd = null;
    let errFd = null;
    let timer = null;
    let settled = false;
    let timedOut = false;
    let child = null;

    const closeFiles = () => {
      if (outFd !== null) {
        try {
          fs.closeSync(outFd);
        } catch {
          // already closed
        }
        outFd = null;
      }
      if (errFd !== null) {
        try {
          fs.closeSync(errFd);
        } catch {
          // already closed
        }
        errFd = null;
      }
    };

    const cleanup = () => {
      closeFiles();
      if (tempDir === null) return;
      const directory = tempDir;
      tempDir = null;
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // best effort: a leftover temp directory is harmless
      }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cleanup();
      resolve(result);
    };

    const captured = () => {
      if (tempDir === null) return { stdout: Buffer.alloc(0), stderr: '', truncated: false };
      const out = readBoundedFile(path.join(tempDir, 'stdout'), maxBytes);
      const err = readBoundedFile(path.join(tempDir, 'stderr'), 64 * 1024);
      return { stdout: out.buffer, stderr: err.buffer.toString('utf8'), truncated: out.truncated };
    };

    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-c2c-proc-'));
      outFd = fs.openSync(path.join(tempDir, 'stdout'), 'w');
      errFd = fs.openSync(path.join(tempDir, 'stderr'), 'w');
      child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', outFd, errFd] });
    } catch (error) {
      finish({
        ok: false,
        code: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        truncated: false,
        timedOut: false,
        error,
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // the child may already be gone
      }
    }, timeoutMs);

    child.on('error', (error) => {
      closeFiles();
      finish({ ok: false, code: null, signal: null, ...captured(), timedOut, error });
    });
    child.on('close', (code, signal) => {
      closeFiles();
      finish({ ok: code === 0, code, signal: signal ?? null, ...captured(), timedOut, error: null });
    });
  });
}

/**
 * Decode at most `maxBytes` of a UTF-8 buffer without splitting a code point.
 * @param {Buffer} buffer
 * @param {number} maxBytes
 * @returns {string}
 */
function utf8Slice(buffer, maxBytes) {
  const limit = Math.max(0, Math.min(maxBytes, buffer.length));
  let end = limit;
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function sliceTextToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) return String(text);
  return utf8Slice(buffer, maxBytes);
}

/* ----------------------------------------------------------------- image --- */

const IMAGE_MIME_BY_KIND = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

/**
 * Identify a raster image by magic bytes. SVG and other text formats return null.
 * @param {Buffer} buffer
 * @returns {'png' | 'jpeg' | 'gif' | 'webp' | null}
 */
function detectImageKind(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** @param {Buffer} buffer @returns {boolean} */
function looksLikeSvg(buffer) {
  const head = buffer
    .subarray(0, Math.min(buffer.length, 2048))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return head.startsWith('<svg') || head.includes('<svg');
}

/** @param {Buffer} buffer @returns {{ width: number, height: number } | null} */
function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** @param {Buffer} buffer @returns {{ width: number, height: number } | null} */
function readWebpDimensions(buffer) {
  if (buffer.length >= 30 && buffer.subarray(12, 16).toString('latin1') === 'VP8X') {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  return null;
}

/**
 * @param {'png' | 'jpeg' | 'gif' | 'webp'} kind
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number } | null}
 */
function readImageDimensions(kind, buffer) {
  try {
    if (kind === 'png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (kind === 'gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (kind === 'jpeg') return readJpegDimensions(buffer);
    if (kind === 'webp') return readWebpDimensions(buffer);
  } catch {
    return null;
  }
  return null;
}

/* ------------------------------------------------------ project detection --- */

const EXTENSION_LANGUAGES = Object.freeze({
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.hpp': 'C++',
  '.swift': 'Swift',
  '.m': 'Objective-C',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.lua': 'Lua',
  '.dart': 'Dart',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sql': 'SQL',
  '.r': 'R',
  '.scala': 'Scala',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.zig': 'Zig',
});

const PROJECT_TYPE_MARKERS = Object.freeze([
  ['node', ['package.json']],
  ['python', ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile']],
  ['rust', ['Cargo.toml']],
  ['go', ['go.mod']],
  ['java', ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  ['php', ['composer.json']],
  ['ruby', ['Gemfile']],
  ['cpp', ['CMakeLists.txt']],
]);

const PROJECT_TYPE_LANGUAGES = Object.freeze({
  node: 'JavaScript',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  php: 'PHP',
  ruby: 'Ruby',
  cpp: 'C++',
  dotnet: 'C#',
});

const FRAMEWORK_DEPENDENCIES = Object.freeze([
  ['next', 'Next.js'],
  ['react', 'React'],
  ['react-dom', 'React'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['solid-js', 'Solid'],
  ['preact', 'Preact'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['koa', 'Koa'],
  ['@nestjs/core', 'NestJS'],
  ['hono', 'Hono'],
  ['electron', 'Electron'],
  ['@tauri-apps/api', 'Tauri'],
]);

const PYTHON_FRAMEWORKS = Object.freeze([
  ['django', 'Django'],
  ['fastapi', 'FastAPI'],
  ['flask', 'Flask'],
  ['starlette', 'Starlette'],
]);

/** @param {string} line @returns {string | null} */
function parseBranchHeader(line) {
  const header = String(line ?? '').trim();
  if (header === '') return null;
  if (header.startsWith('No commits yet on ')) return header.slice('No commits yet on '.length).trim() || null;
  if (header === 'HEAD (no branch)') return 'HEAD';
  const separator = header.indexOf('...');
  const base = separator === -1 ? header : header.slice(0, separator);
  return base.split(' ')[0].trim() || null;
}

/** @param {number | string | undefined} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.trunc(number);
}

/** @param {object | undefined} limits @returns {Readonly<object>} */
function normalizeLimits(limits) {
  const input = limits && typeof limits === 'object' ? limits : {};
  return Object.freeze({
    allowSensitive: input.allowSensitive === true,
    // `maxFileBytes` is the name the host config uses for the same cap; accept
    // either spelling so a caller never silently loses its limit.
    maxReadBytes: positiveInt(input.maxReadBytes ?? input.maxFileBytes, DEFAULT_LIMITS.maxReadBytes),
    maxScanBytes: positiveInt(input.maxScanBytes, DEFAULT_LIMITS.maxScanBytes),
    maxImageBytes: positiveInt(input.maxImageBytes, DEFAULT_LIMITS.maxImageBytes),
    maxDiffBytes: positiveInt(input.maxDiffBytes, DEFAULT_LIMITS.maxDiffBytes),
    maxListEntries: positiveInt(input.maxListEntries, DEFAULT_LIMITS.maxListEntries),
    maxGitEntries: positiveInt(input.maxGitEntries, DEFAULT_LIMITS.maxGitEntries),
    searchMaxFiles: positiveInt(input.searchMaxFiles, DEFAULT_LIMITS.searchMaxFiles),
    searchMaxFileBytes: positiveInt(input.searchMaxFileBytes, DEFAULT_LIMITS.searchMaxFileBytes),
    searchMaxMatches: positiveInt(input.searchMaxMatches, DEFAULT_LIMITS.searchMaxMatches),
    useRipgrep: input.useRipgrep !== false,
    rgPath: typeof input.rgPath === 'string' && input.rgPath.trim() !== '' ? input.rgPath.trim() : null,
    rgTimeoutMs: positiveInt(input.rgTimeoutMs, DEFAULT_LIMITS.rgTimeoutMs),
    gitTimeoutMs: positiveInt(input.gitTimeoutMs, DEFAULT_LIMITS.gitTimeoutMs),
  });
}

/**
 * Probe a ripgrep executable once per process.
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function probeRipgrep(command, timeoutMs) {
  const result = await runProcess(command, ['--version'], {
    maxBytes: 8 * 1024,
    timeoutMs: Math.min(timeoutMs, 5000),
  });
  return !result.error && result.code === 0;
}

/* --------------------------------------------------------------- Workspace --- */

/**
 * Read-only view of one workspace directory. Construct through
 * `Workspace.create({ root, limits })` so the root is realpath'd exactly once.
 */
export class Workspace {
  /**
   * @param {string} root absolute, realpath'd workspace root
   * @param {object} [limits]
   */
  constructor(root, limits) {
    this._root = root;
    this._limits = normalizeLimits(limits);
  }

  /**
   * Open a workspace, resolving `root` through realpath and verifying it is a
   * directory. Throws `{ code: 'INVALID_WORKSPACE' }` otherwise.
   * @param {{ root: string, limits?: object }} [options]
   * @returns {Promise<Workspace>}
   */
  static async create({ root, limits } = {}) {
    const realRoot = await toRealRootAsync(root);
    return new Workspace(realRoot, limits);
  }

  /** @returns {string} absolute, realpath'd workspace root */
  get root() {
    return this._root;
  }

  /** @returns {string} basename of the workspace root */
  get name() {
    return path.basename(this._root) || this._root;
  }

  /* ------------------------------------------------------------ internals --- */

  /**
   * Resolve a caller-supplied path against the workspace, enforcing containment
   * and (unless `allowSensitive`) the sensitive deny list.
   * @param {string} candidate
   * @returns {string}
   */
  _resolve(candidate) {
    return resolveContained(this._root, candidate, { allowSensitive: this._limits.allowSensitive });
  }

  /**
   * @param {string} absolute
   * @returns {string}
   */
  _relative(absolute) {
    return relativeOf(this._root, absolute) ?? '.';
  }

  /**
   * @param {string} relativePath
   * @param {((relPath: string) => Promise<boolean>) | null} [matcher]
   * @returns {Promise<boolean>}
   */
  async _shouldSkip(relativePath, matcher) {
    if (isDefaultSkipped(relativePath)) return true;
    if (!this._limits.allowSensitive && isSensitivePath(relativePath)) return true;
    if (matcher && (await matcher(relativePath))) return true;
    return false;
  }

  /**
   * Bounded, breadth-first file scan used for project detection.
   * @param {number} maxFiles
   * @param {number} maxDepth
   * @returns {Promise<Array<{ abs: string, name: string, rel: string }>>}
   */
  async _scanFiles(maxFiles, maxDepth) {
    const files = [];
    const queue = [{ abs: this._root, depth: 0 }];
    while (queue.length > 0 && files.length < maxFiles) {
      const current = queue.shift();
      let dirents;
      try {
        dirents = await fsp.readdir(current.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const dirent of dirents) {
        if (files.length >= maxFiles) break;
        if (SKIPPED_DIRECTORIES.has(dirent.name)) continue;
        const abs = path.join(current.abs, dirent.name);
        const rel = toPosix(path.relative(this._root, abs));
        if (!this._limits.allowSensitive && isSensitivePath(rel)) continue;
        if (dirent.isDirectory()) {
          if (current.depth + 1 < maxDepth) queue.push({ abs, depth: current.depth + 1 });
        } else if (dirent.isFile()) {
          files.push({ abs, name: dirent.name, rel });
        }
      }
    }
    return files;
  }

  /**
   * @param {string} absolute
   * @param {number} maxBytes
   * @returns {Promise<string>}
   */
  async _readTextIfSmall(absolute, maxBytes) {
    try {
      const stats = await fsp.stat(absolute);
      if (!stats.isFile() || stats.size > maxBytes) return '';
      const buffer = await fsp.readFile(absolute);
      return buffer.toString('utf8');
    } catch {
      return '';
    }
  }

  /** @returns {Promise<object | null>} */
  async _readPackageJson() {
    const text = await this._readTextIfSmall(path.join(this._root, 'package.json'), 256 * 1024);
    if (text === '') return null;
    const parsed = safeJsonParse(text, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  }

  /**
   * @param {string[]} args
   * @param {{ maxBytes?: number }} [options]
   */
  _git(args, options = {}) {
    return runProcess('git', args, {
      cwd: this._root,
      env: {
        ...process.env,
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        LANG: 'C',
      },
      maxBytes: options.maxBytes ?? 64 * 1024,
      timeoutMs: this._limits.gitTimeoutMs,
    });
  }

  /**
   * @param {object | null} packageJson
   * @param {Set<string>} rootNames
   * @returns {Promise<string[]>}
   */
  async _detectFrameworks(packageJson, rootNames) {
    const frameworks = [];
    if (packageJson) {
      const dependencies = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
        ...(packageJson.peerDependencies ?? {}),
      };
      for (const [dependency, framework] of FRAMEWORK_DEPENDENCIES) {
        if (Object.prototype.hasOwnProperty.call(dependencies, dependency) && !frameworks.includes(framework)) {
          frameworks.push(framework);
        }
      }
    }
    const pythonSources = [];
    for (const name of ['pyproject.toml', 'requirements.txt', 'Pipfile']) {
      if (!rootNames.has(name)) continue;
      const text = await this._readTextIfSmall(path.join(this._root, name), 256 * 1024);
      if (text !== '') pythonSources.push(text.toLowerCase());
    }
    if (pythonSources.length > 0) {
      const haystack = pythonSources.join('\n');
      for (const [needle, framework] of PYTHON_FRAMEWORKS) {
        if (haystack.includes(needle) && !frameworks.includes(framework)) frameworks.push(framework);
      }
    }
    return frameworks;
  }

  /**
   * Read-only git metadata for `info()`.
   * @returns {Promise<{ available: boolean, branch: string | null, remote?: string }>}
   */
  async _gitInfo() {
    const check = await this._git(['rev-parse', '--is-inside-work-tree'], { maxBytes: 4096 });
    if (check.error || check.code !== 0 || check.stdout.toString('utf8').trim() !== 'true') {
      return { available: false, branch: null };
    }
    const branchResult = await this._git(['rev-parse', '--abbrev-ref', 'HEAD'], { maxBytes: 4096 });
    let branch = null;
    if (!branchResult.error && branchResult.code === 0) {
      const value = branchResult.stdout.toString('utf8').trim();
      if (value !== '') branch = value;
    }
    const result = { available: true, branch };
    const remoteResult = await this._git(['remote', 'get-url', 'origin'], { maxBytes: 8192 });
    if (!remoteResult.error && remoteResult.code === 0) {
      const url = remoteResult.stdout.toString('utf8').trim();
      if (url !== '') result.remote = url;
    }
    return result;
  }

  /* ------------------------------------------------------------------ info --- */

  /**
   * Summarize the workspace for the ChatGPT planning loop.
   * @returns {Promise<{ name: string, root: string, description?: string, projectType: string, languages: string[], frameworks: string[], git: { available: boolean, branch: string | null, remote?: string } }>}
   */
  async info() {
    const rootEntries = await fsp.readdir(this._root, { withFileTypes: true }).catch(() => []);
    const rootNames = new Set(rootEntries.map((entry) => entry.name));
    const visibleNames = rootEntries
      .map((entry) => entry.name)
      .filter((name) => name !== '.git' && name !== 'node_modules');
    const files = await this._scanFiles(400, 2);

    const counts = new Map();
    for (const file of files) {
      const language = EXTENSION_LANGUAGES[path.extname(file.name).toLowerCase()];
      if (!language) continue;
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }

    const markerLanguages = new Set();
    let projectType = 'generic';
    for (const [type, markers] of PROJECT_TYPE_MARKERS) {
      if (markers.some((name) => rootNames.has(name))) {
        projectType = type;
        markerLanguages.add(PROJECT_TYPE_LANGUAGES[type]);
        break;
      }
    }
    if (projectType === 'generic' && visibleNames.some((name) => /\.(sln|csproj)$/i.test(name))) {
      projectType = 'dotnet';
      markerLanguages.add('C#');
    }
    if (rootNames.has('tsconfig.json')) markerLanguages.add('TypeScript');
    if (projectType === 'generic' && files.length === 0 && visibleNames.length === 0) projectType = 'empty';

    const packageJson = await this._readPackageJson();
    const frameworks = await this._detectFrameworks(packageJson, rootNames);
    const languages = [...new Set([...counts.keys(), ...markerLanguages])].sort((left, right) => {
      const leftCount = counts.get(left) ?? 0;
      const rightCount = counts.get(right) ?? 0;
      if (leftCount !== rightCount) return rightCount - leftCount;
      return left.localeCompare(right);
    });
    const description =
      packageJson && typeof packageJson.description === 'string' && packageJson.description.trim() !== ''
        ? packageJson.description.trim()
        : undefined;

    return {
      name: this.name,
      root: this._root,
      description,
      projectType,
      languages,
      frameworks,
      git: await this._gitInfo(),
    };
  }

  /* -------------------------------------------------------- listDirectory --- */

  /**
   * List entries below a directory, depth-first bounded and paginated.
   * @param {{ path?: string, depth?: number, limit?: number, offset?: number }} [options]
   * @returns {Promise<{ path: string, entries: Array<{ name: string, path: string, type: 'file' | 'dir' | 'symlink', size: number, mtime: string }>, total: number, truncated: boolean }>}
   */
  async listDirectory({ path: relPath = '.', depth = 1, limit = 200, offset = 0 } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') throw invalidArgs('path must be a non-empty string');
    const depthLevels = clampInt(depth, 1, 8, 1);
    const pageLimit = clampInt(limit, 1, 1000, 200);
    const pageOffset = clampInt(offset, 0, 1000000000, 0);
    const baseAbs = this._resolve(relPath);
    const baseRelative = this._relative(baseAbs);
    const matcher = await loadIgnoreMatcher(this._root);
    const queue = [{ abs: baseAbs, depth: 0 }];
    const collected = [];
    let truncatedByScan = false;
    while (queue.length > 0) {
      const current = queue.shift();
      let dirents;
      try {
        dirents = await fsp.readdir(current.abs, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') throw notFound(relPath);
        if (error?.code === 'ENOTDIR') throw invalidArgs(`not a directory: ${truncate(relPath, 200)}`);
        throw workspaceError('ACCESS_DENIED', `cannot list directory: ${error?.code ?? 'ERROR'}`);
      }
      dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const dirent of dirents) {
        if (collected.length >= this._limits.maxListEntries) {
          truncatedByScan = true;
          break;
        }
        const abs = path.join(current.abs, dirent.name);
        const relative = toPosix(path.relative(this._root, abs));
        let stats;
        try {
          stats = await fsp.lstat(abs);
        } catch {
          continue;
        }
        // `lstat` reports a Windows junction as a directory, while the dirent
        // knows it is a reparse point, so both are consulted.
        const type =
          dirent.isSymbolicLink() || stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'dir' : 'file';
        // A trailing slash lets `dir/` rules in `.c2cignore` match the entry.
        if (await this._shouldSkip(type === 'dir' ? `${relative}/` : relative, matcher)) continue;
        collected.push({
          name: dirent.name,
          path: relative,
          type,
          size: stats.size,
          mtime: new Date(stats.mtimeMs).toISOString(),
        });
        if (type === 'dir' && current.depth + 1 < depthLevels) {
          queue.push({ abs, depth: current.depth + 1 });
        }
      }
      if (truncatedByScan) break;
    }
    collected.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const total = collected.length;
    const entries = collected.slice(pageOffset, pageOffset + pageLimit);
    return {
      path: baseRelative,
      entries,
      total,
      truncated: truncatedByScan || pageOffset + entries.length < total,
    };
  }

  /* -------------------------------------------------------------- readFile --- */

  /**
   * Read a text file with optional 1-based inclusive line window and a hard byte
   * cap. Binary files (NUL byte in the first 8 KiB) return `binary: true` and no
   * content. Files larger than `limits.maxScanBytes` are not line-counted to the
   * end and report `totalLines: -1`.
   *
   * @param {{ path: string, startLine?: number, endLine?: number, maxBytes?: number }} [options]
   * @returns {Promise<{ path: string, content: string, startLine: number, endLine: number, totalLines: number, bytes: number, truncated: boolean, binary: boolean }>}
   */
  async readFile({ path: relPath, startLine, endLine, maxBytes } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') throw invalidArgs('path must be a non-empty string');
    const cap = Math.min(clampInt(maxBytes, 1, this._limits.maxReadBytes, this._limits.maxReadBytes), this._limits.maxReadBytes);
    const absolute = this._resolve(relPath);
    const displayPath = this._relative(absolute);
    const start = clampInt(startLine, 1, Number.MAX_SAFE_INTEGER, 1);
    let end;
    if (endLine !== undefined && endLine !== null) {
      const parsed = Number.parseInt(String(endLine), 10);
      if (Number.isFinite(parsed)) end = Math.max(start, Math.min(parsed, Number.MAX_SAFE_INTEGER));
    }
    let stats;
    try {
      stats = await fsp.stat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(relPath);
      if (error?.code === 'EACCES' || error?.code === 'EPERM') throw workspaceError('ACCESS_DENIED', `cannot read file: ${error.code}`);
      throw workspaceError('NOT_FOUND', `cannot read file (${error?.code ?? 'ERROR'})`);
    }
    if (stats.isDirectory()) throw invalidArgs(`path is a directory: ${truncate(relPath, 200)}`);
    if (!stats.isFile()) throw invalidArgs(`path is not a regular file: ${truncate(relPath, 200)}`);

    const handle = await fsp.open(absolute, 'r');
    try {
      const fileInfo = await handle.stat();
      const sniffSize = Math.min(8192, fileInfo.size);
      const sniff = Buffer.alloc(sniffSize);
      if (sniffSize > 0) await handle.read(sniff, 0, sniffSize, 0);
      if (sniff.includes(0)) {
        return {
          path: displayPath,
          content: '',
          startLine: start,
          endLine: start - 1,
          totalLines: 0,
          bytes: fileInfo.size,
          truncated: false,
          binary: true,
        };
      }

      const lines = [];
      let byteCount = 0;
      let stopCapturing = false;
      let truncatedByBytes = false;
      let completeLines = 0;
      let seenLines = 0;
      const consumeLine = (lineText) => {
        seenLines += 1;
        if (stopCapturing) return;
        if (seenLines < start) return;
        if (end !== undefined && seenLines > end) {
          stopCapturing = true;
          return;
        }
        const separator = lines.length === 0 ? 0 : 1;
        const needed = bytesOf(lineText) + separator;
        if (byteCount + needed <= cap) {
          lines.push(lineText);
          byteCount += needed;
          if (end !== undefined && seenLines >= end) stopCapturing = true;
          return;
        }
        const room = cap - byteCount - separator;
        if (room > 0) {
          const piece = sliceTextToBytes(lineText, room);
          if (piece !== '') {
            lines.push(piece);
            byteCount += bytesOf(piece) + separator;
          }
        }
        stopCapturing = true;
        truncatedByBytes = true;
      };

      const scanLimit = Math.min(fileInfo.size, this._limits.maxScanBytes);
      const scanLimited = fileInfo.size > scanLimit;
      const chunk = Buffer.alloc(64 * 1024);
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let position = 0;
      while (position < scanLimit) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, scanLimit - position), position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        let text = carry + decoder.write(chunk.subarray(0, bytesRead));
        let cursor = 0;
        let newline = text.indexOf('\n', cursor);
        while (newline !== -1) {
          consumeLine(text.slice(cursor, newline).replace(/\r$/, ''));
          completeLines += 1;
          cursor = newline + 1;
          newline = text.indexOf('\n', cursor);
        }
        carry = text.slice(cursor);
      }
      const tail = carry + decoder.end();
      if (!scanLimited && tail !== '') consumeLine(tail.replace(/\r$/, ''));
      const totalLines = scanLimited ? -1 : completeLines + (!scanLimited && tail !== '' ? 1 : 0);
      let truncated = truncatedByBytes || scanLimited;
      if (!truncated && end === undefined && lines.length > 0) {
        const lastCaptured = start + lines.length - 1;
        if (totalLines >= 0 && lastCaptured < totalLines) truncated = true;
      }
      const content = stripBom(lines.join('\n'));
      return {
        path: displayPath,
        content,
        startLine: start,
        endLine: lines.length > 0 ? start + lines.length - 1 : start - 1,
        totalLines,
        bytes: bytesOf(content),
        truncated,
        binary: false,
      };
    } finally {
      await handle.close();
    }
  }

  /* ---------------------------------------------------------------- search --- */

  /**
   * @param {{ query: string, regex?: boolean, caseSensitive?: boolean, glob?: string, limit?: number }} [options]
   * @returns {Promise<{ query: string, matches: Array<{ path: string, line: number, text: string }>, total: number, truncated: boolean, engine: 'rg' | 'node' }>}
   */
  async search({ query, regex = false, caseSensitive = false, glob, limit = 100 } = {}) {
    if (typeof query !== 'string' || query.trim() === '') throw invalidArgs('query must be a non-empty string');
    if (query.length > MAX_QUERY_LENGTH) throw invalidArgs(`query must be at most ${MAX_QUERY_LENGTH} characters`);
    const pageLimit = clampInt(limit, 1, 500, 100);
    if (regex) {
      try {
        // Compile once up front so the bounded Node fallback cannot throw later.
        new RegExp(query, caseSensitive ? '' : 'i'); // eslint-disable-line no-new
      } catch {
        throw invalidArgs('query is not a valid regular expression');
      }
    }
    let globPattern = null;
    if (glob !== undefined && glob !== null) {
      if (typeof glob !== 'string') throw invalidArgs('glob must be a string');
      const trimmed = glob.trim();
      if (trimmed !== '') {
        if (trimmed.length > MAX_GLOB_LENGTH) throw invalidArgs(`glob must be at most ${MAX_GLOB_LENGTH} characters`);
        globPattern = trimmed;
      }
    }
    const normalised = { query, regex: regex === true, caseSensitive: caseSensitive === true, glob: globPattern, limit: pageLimit };
    const matcher = await loadIgnoreMatcher(this._root);
    if (this._limits.useRipgrep) {
      const command = await this._ripgrepCommand();
      if (command) {
        const result = await this._searchWithRipgrep(command, { ...normalised, matcher });
        if (result) return { ...result, engine: 'rg' };
      }
    }
    const fallback = await this._searchWithNode({ ...normalised, matcher });
    return { ...fallback, engine: 'node' };
  }

  /** @returns {Promise<string | null>} */
  async _ripgrepCommand() {
    const command = this._limits.rgPath || 'rg';
    let probe = RG_PROBE_CACHE.get(command);
    if (!probe) {
      probe = probeRipgrep(command, this._limits.rgTimeoutMs);
      RG_PROBE_CACHE.set(command, probe);
    }
    return (await probe) ? command : null;
  }

  /**
   * @param {string} command
   * @param {{ query: string, regex: boolean, caseSensitive: boolean, glob: string | null, limit: number, matcher: Function }} options
   * @returns {Promise<{ query: string, matches: object[], total: number, truncated: boolean } | null>}
   */
  async _searchWithRipgrep(command, { query, regex, caseSensitive, glob, limit, matcher }) {
    const args = ['--json', '--no-messages', '--color', 'never', '--max-filesize', String(this._limits.searchMaxFileBytes)];
    if (!caseSensitive) args.push('-i');
    if (!regex) args.push('-F');
    if (glob) args.push('-g', glob);
    args.push('--', query, '.');
    const result = await runProcess(command, args, {
      cwd: this._root,
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: this._limits.rgTimeoutMs,
    });
    if (result.error || result.timedOut) return null;
    const matches = [];
    let total = 0;
    let truncated = result.truncated;
    for (const line of result.stdout.toString('utf8').split('\n')) {
      if (line === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || record.type !== 'match') continue;
      const data = record.data ?? {};
      const rawPath = data.path && typeof data.path.text === 'string' ? data.path.text : '';
      if (rawPath === '') continue;
      const relative = toPosix(rawPath).replace(/^\.\//, '');
      if (await this._shouldSkip(relative, matcher)) continue;
      total += 1;
      if (matches.length < limit) {
        const rawLine = data.lines && typeof data.lines.text === 'string' ? data.lines.text : '';
        matches.push({
          path: relative,
          line: Number(data.line_number) || 0,
          text: truncate(rawLine.replace(/\r?\n$/, ''), SEARCH_TEXT_MAX),
        });
      }
      if (total >= this._limits.searchMaxMatches) {
        truncated = true;
        break;
      }
    }
    if (total === 0 && result.code !== 0 && result.code !== 1) return null;
    return { query, matches, total, truncated: truncated || total > limit };
  }

  /**
   * Bounded recursive Node fallback used when ripgrep is unavailable.
   * @param {{ query: string, regex: boolean, caseSensitive: boolean, glob: string | null, limit: number, matcher: Function }} options
   * @returns {Promise<{ query: string, matches: object[], total: number, truncated: boolean }>}
   */
  async _searchWithNode({ query, regex, caseSensitive, glob, limit, matcher }) {
    const compiled = regex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
    const needle = caseSensitive ? query : query.toLowerCase();
    const globFilter = glob ? compileGlobFilter(glob) : null;
    const matches = [];
    let total = 0;
    let truncated = false;
    let filesScanned = 0;
    let stop = false;
    const stack = [this._root];
    while (stack.length > 0 && !stop) {
      const directory = stack.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const dirent of dirents) {
        if (stop) break;
        const abs = path.join(directory, dirent.name);
        const relative = toPosix(path.relative(this._root, abs));
        if (dirent.isDirectory()) {
          if (!(await this._shouldSkip(`${relative}/`, matcher))) stack.push(abs);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (await this._shouldSkip(relative, matcher)) continue;
        if (globFilter && !globFilter(relative)) continue;
        filesScanned += 1;
        if (filesScanned > this._limits.searchMaxFiles) {
          truncated = true;
          stop = true;
          break;
        }
        let buffer;
        try {
          buffer = await fsp.readFile(abs);
        } catch {
          continue;
        }
        if (buffer.length > this._limits.searchMaxFileBytes) continue;
        if (buffer.subarray(0, Math.min(8192, buffer.length)).includes(0)) continue;
        const text = buffer.toString('utf8');
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const hit = compiled ? compiled.test(line) : caseSensitive ? line.includes(needle) : line.toLowerCase().includes(needle);
          if (!hit) continue;
          total += 1;
          if (matches.length < limit) {
            matches.push({ path: relative, line: index + 1, text: truncate(line, SEARCH_TEXT_MAX) });
          }
          if (total >= this._limits.searchMaxMatches) {
            truncated = true;
            stop = true;
            break;
          }
        }
      }
    }
    matches.sort((left, right) => (left.path === right.path ? left.line - right.line : left.path < right.path ? -1 : 1));
    return { query, matches, total, truncated: truncated || total > limit };
  }

  /* ------------------------------------------------------------- gitStatus --- */

  /**
   * `git status --porcelain=v1 -z --branch` snapshot.
   * @returns {Promise<{ available: boolean, branch: string | null, clean: boolean, entries: Array<{ status: string, path: string }>, total: number, truncated: boolean, error?: string }>}
   */
  async gitStatus() {
    const result = await this._git(
      ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal'],
      { maxBytes: this._limits.maxGitEntries * 512 + 16384 },
    );
    if (result.error || /not a git repository|not a work tree/i.test(result.stderr)) {
      const response = { available: false, branch: null, clean: true, entries: [], total: 0, truncated: false };
      if (result.error) response.error = 'git is not available';
      return response;
    }
    if (result.code !== 0 && result.stdout.length === 0) {
      return { available: false, branch: null, clean: true, entries: [], total: 0, truncated: false, error: 'git status failed' };
    }
    const records = result.stdout.toString('utf8').split('\0');
    let branch = null;
    let index = 0;
    if (records.length > 0 && records[0].startsWith('## ')) {
      branch = parseBranchHeader(records[0].slice(3));
      index = 1;
    }
    const entries = [];
    let truncated = result.truncated;
    for (; index < records.length; index += 1) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      const status = record.slice(0, 2).trim() || '??';
      const filePath = record.slice(3);
      if (filePath === '') continue;
      entries.push({ status, path: toPosix(filePath) });
      if (entries.length >= this._limits.maxGitEntries) {
        truncated = true;
        break;
      }
      if (record[0] === 'R' || record[0] === 'C') index += 1;
    }
    return {
      available: true,
      branch,
      clean: entries.length === 0,
      entries,
      total: entries.length,
      truncated,
    };
  }

  /* --------------------------------------------------------------- gitDiff --- */

  /**
   * Unified diff of the working tree (or the staged index). Read-only.
   * @param {{ staged?: boolean, path?: string, maxBytes?: number }} [options]
   * @returns {Promise<{ available: boolean, content: string, truncated: boolean, bytes: number }>}
   */
  async gitDiff({ staged = false, path: relPath, maxBytes } = {}) {
    const cap = Math.min(clampInt(maxBytes, 1, this._limits.maxDiffBytes, this._limits.maxDiffBytes), this._limits.maxDiffBytes);
    const args = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv'];
    if (staged === true) args.push('--staged');
    if (relPath !== undefined && relPath !== null) {
      if (typeof relPath !== 'string' || relPath.trim() === '') throw invalidArgs('path must be a non-empty string');
      const absolute = this._resolve(relPath);
      args.push('--', this._relative(absolute));
    }
    const result = await this._git(args, { maxBytes: cap + 4096 });
    if (result.error || result.timedOut || /not a git repository|not a work tree/i.test(result.stderr)) {
      return { available: false, content: '', truncated: false, bytes: 0 };
    }
    const content = utf8Slice(result.stdout, cap);
    return {
      available: true,
      content,
      truncated: result.truncated || result.stdout.length > cap,
      bytes: bytesOf(content),
    };
  }

  /* -------------------------------------------------------------- readImage --- */

  /**
   * Read a raster image (PNG/JPEG/GIF/WebP) as base64. SVG and other active or
   * text formats are rejected with `{ code: 'UNSUPPORTED_IMAGE' }`; oversized
   * files with `{ code: 'TOO_LARGE' }`.
   * @param {{ path: string, maxBytes?: number }} [options]
   * @returns {Promise<{ path: string, mimeType: string, base64: string, bytes: number, width?: number, height?: number }>}
   */
  async readImage({ path: relPath, maxBytes } = {}) {
    if (typeof relPath !== 'string' || relPath.trim() === '') throw invalidArgs('path must be a non-empty string');
    const cap = Math.min(
      clampInt(maxBytes, 1, this._limits.maxImageBytes, this._limits.maxImageBytes),
      this._limits.maxImageBytes,
    );
    const absolute = this._resolve(relPath);
    const displayPath = this._relative(absolute);
    let stats;
    try {
      stats = await fsp.stat(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(relPath);
      throw workspaceError('NOT_FOUND', `cannot read image (${error?.code ?? 'ERROR'})`);
    }
    if (!stats.isFile()) throw invalidArgs(`path is not a regular file: ${truncate(relPath, 200)}`);
    if (stats.size > cap) {
      throw workspaceError('TOO_LARGE', `image is ${stats.size} bytes; limit is ${cap}`, { size: stats.size, limit: cap });
    }
    const extension = path.extname(absolute).toLowerCase();
    if (extension === '.svg' || extension === '.svgz') {
      throw workspaceError('UNSUPPORTED_IMAGE', 'SVG is text, not a raster image; use read_file instead', {
        path: displayPath,
        mimeType: 'image/svg+xml',
      });
    }
    const buffer = await fsp.readFile(absolute);
    const kind = detectImageKind(buffer);
    if (!kind) {
      if (looksLikeSvg(buffer)) {
        throw workspaceError('UNSUPPORTED_IMAGE', 'SVG is text, not a raster image; use read_file instead', {
          path: displayPath,
          mimeType: 'image/svg+xml',
        });
      }
      throw workspaceError('UNSUPPORTED_IMAGE', 'file is not a supported image (PNG, JPEG, GIF, WebP)', { path: displayPath });
    }
    const dimensions = readImageDimensions(kind, buffer);
    const result = {
      path: displayPath,
      mimeType: IMAGE_MIME_BY_KIND[kind],
      base64: buffer.toString('base64'),
      bytes: buffer.length,
    };
    if (dimensions && Number.isInteger(dimensions.width) && Number.isInteger(dimensions.height)) {
      result.width = dimensions.width;
      result.height = dimensions.height;
    }
    return result;
  }
}

/**
 * Build a predicate for a ripgrep-style `-g` glob: patterns without `/` match a
 * basename at any depth, patterns with `/` match the whole relative path.
 * @param {string} glob
 * @returns {(relPath: string) => boolean}
 */
function compileGlobFilter(glob) {
  const pattern = toPosix(String(glob)).trim().replace(/^\.\//, '').replace(/^\/+/, '');
  const anchored = pattern.includes('/');
  const regex = new RegExp(anchored ? `^${segmentsToRegex(pattern)}$` : `^(?:.*/)?${segmentsToRegex(pattern)}$`);
  return (relPath) => regex.test(toPosix(relPath));
}
