// Unit tests for lib/workspace.js — the read-only, contained workspace layer.
// Every fixture lives in the OS temp directory (never inside the repository) and
// nothing here touches the network. node:test + node:assert/strict only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Workspace, isSensitivePath, loadIgnoreMatcher, resolveInWorkspace } from '../lib/workspace.js';

const IS_WINDOWS = process.platform === 'win32';

/** 1x1 transparent PNG — valid IHDR, so the dimension reader has real work. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Minimal SVG document: text, never a raster image. */
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

/* --------------------------------------------------------------- fixtures --- */

/**
 * Create a throwaway workspace rooted in the OS temp dir and register its
 * removal with the test context.
 * @param {import('node:test').TestContext} t
 * @param {object} [limits]
 * @returns {Promise<{ root: string, workspace: Workspace, write: (rel: string, data: string | Buffer) => Promise<string>, mkdir: (rel: string) => Promise<string>, outside: string }>}
 */
async function makeWorkspace(t, limits) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'c2c-ws-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'c2c-outside-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
  });
  const write = async (rel, data) => {
    const target = path.join(root, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    return target;
  };
  const mkdir = async (rel) => {
    const target = path.join(root, rel);
    await fsp.mkdir(target, { recursive: true });
    return target;
  };
  const workspace = await Workspace.create({ root, limits });
  return { root, workspace, write, mkdir, outside };
}

/**
 * Assert that `run()` rejects with a real Error carrying `code`.
 * @param {() => Promise<unknown>} run
 * @param {string} code
 * @returns {Promise<Error>}
 */
async function rejectsWithCode(run, code) {
  let caught = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected an Error with code ${code}`);
  assert.equal(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

/* -------------------------------------------------------------- pure core --- */

test('isSensitivePath denies credential files but allows env templates', () => {
  for (const denied of [
    '.env',
    '.env.local',
    '.env.production',
    'config/.env',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'certs/server.pem',
    'certs/server.key',
    'bundle.p12',
    'bundle.pfx',
    'vault.kdbx',
    '.ssh/config',
    'home/.aws/credentials',
    '.gnupg/private.key',
    '.npmrc',
    '.netrc',
    'credentials.json',
    '.git/config',
    'nested/.git/config',
  ]) {
    assert.equal(isSensitivePath(denied), true, `${denied} should be sensitive`);
  }

  for (const allowed of ['.env.example', '.env.sample', 'src/app.js', 'README.md', 'docs/.env.example', '.gitignore']) {
    assert.equal(isSensitivePath(allowed), false, `${allowed} should not be sensitive`);
  }

  assert.equal(isSensitivePath(''), false);
  assert.equal(isSensitivePath('.'), false);
  // Case folding: the deny list must not be bypassed by spelling.
  assert.equal(isSensitivePath('.ENV'), true);
  assert.equal(isSensitivePath('ID_RSA'), true);
});

test('resolveInWorkspace returns contained real paths and rejects escapes', async (t) => {
  const { root, write } = await makeWorkspace(t);
  const file = await write('src/app.js', 'console.log(1);\n');

  assert.equal(resolveInWorkspace(root, 'src/app.js'), file);
  assert.equal(resolveInWorkspace(root, '.'), root);

  await rejectsWithCode(async () => resolveInWorkspace(root, '../outside.txt'), 'PATH_ESCAPE');
  await rejectsWithCode(async () => resolveInWorkspace(root, 'src/../../outside.txt'), 'PATH_ESCAPE');
  await rejectsWithCode(async () => resolveInWorkspace(root, 'bad\0name'), 'INVALID_ARGS');
  await rejectsWithCode(async () => resolveInWorkspace(root, ''), 'INVALID_ARGS');
});

/* ------------------------------------------------------------- containment --- */

test('Workspace.create rejects a missing or non-directory root', async (t) => {
  const missing = path.join(os.tmpdir(), `c2c-missing-${process.pid}-${Date.now()}`);
  await rejectsWithCode(async () => Workspace.create({ root: missing }), 'INVALID_WORKSPACE');
  await rejectsWithCode(async () => Workspace.create({ root: '' }), 'INVALID_WORKSPACE');

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'c2c-file-root-'));
  t.after(async () => {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  });
  const file = path.join(scratch, 'not-a-dir.txt');
  await fsp.writeFile(file, 'x');
  await rejectsWithCode(async () => Workspace.create({ root: file }), 'INVALID_WORKSPACE');
});

test('traversal, other-drive and UNC paths are denied', async (t) => {
  const { root, workspace, write, outside } = await makeWorkspace(t);
  await write('inside.txt', 'inside\n');
  await fsp.writeFile(path.join(outside, 'outside.txt'), 'outside\n');

  await rejectsWithCode(async () => workspace.readFile({ path: '../outside.txt' }), 'PATH_ESCAPE');
  await rejectsWithCode(async () => workspace.readFile({ path: 'a/../../outside.txt' }), 'PATH_ESCAPE');
  await rejectsWithCode(async () => workspace.listDirectory({ path: '..' }), 'PATH_ESCAPE');
  await rejectsWithCode(async () => workspace.readFile({ path: path.join(outside, 'outside.txt') }), 'PATH_ESCAPE');

  const foreignAbsolute = IS_WINDOWS ? 'Z:\\outside.txt' : '/etc/hosts';
  await rejectsWithCode(async () => workspace.readFile({ path: foreignAbsolute }), 'PATH_ESCAPE');
  if (IS_WINDOWS) {
    await rejectsWithCode(async () => workspace.readFile({ path: '\\\\server\\share\\outside.txt' }), 'PATH_ESCAPE');
    // Case-insensitive containment: the root itself, spelled differently, is fine.
    const listed = await workspace.listDirectory({ path: root.toUpperCase() });
    assert.equal(listed.path, '.');
  }

  // A NUL byte is a hard argument error, not a filesystem probe.
  await rejectsWithCode(async () => workspace.readFile({ path: 'bad\0name.txt' }), 'INVALID_ARGS');
  await rejectsWithCode(async () => workspace.listDirectory({ path: 'bad\0dir' }), 'INVALID_ARGS');

  assert.equal((await workspace.readFile({ path: 'inside.txt' })).content, 'inside');
});

test('a directory link that escapes the workspace is denied', async (t) => {
  const { root, workspace, outside } = await makeWorkspace(t);
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'top secret\n');
  const linkPath = path.join(root, 'escape-link');
  try {
    fs.symlinkSync(outside, linkPath, IS_WINDOWS ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`cannot create a directory link here (${error.code})`);
    return;
  }
  await rejectsWithCode(async () => workspace.readFile({ path: 'escape-link/secret.txt' }), 'PATH_ESCAPE');
  await rejectsWithCode(async () => workspace.listDirectory({ path: 'escape-link' }), 'PATH_ESCAPE');
  await rejectsWithCode(
    async () => workspace.readFile({ path: path.join(root, 'escape-link', 'secret.txt') }),
    'PATH_ESCAPE',
  );
  // The link may still be listed as an entry; it is never followed.
  const listing = await workspace.listDirectory({});
  assert.ok(listing.entries.some((entry) => entry.name === 'escape-link'));
});

/* -------------------------------------------------------------- sensitive --- */

test('sensitive files are refused while templates stay readable', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('.env', 'SECRET=hunter2\n');
  await write('.env.example', 'SECRET=\n');
  await write('.env.sample', 'SECRET=\n');
  await write('id_rsa', 'PRIVATE KEY\n');
  await write('certs/server.pem', 'PEM\n');
  await write('src/app.js', 'export const ok = true;\n');

  await rejectsWithCode(async () => workspace.readFile({ path: '.env' }), 'SENSITIVE_FILE');
  await rejectsWithCode(async () => workspace.readFile({ path: 'id_rsa' }), 'SENSITIVE_FILE');
  await rejectsWithCode(async () => workspace.readFile({ path: 'certs/server.pem' }), 'SENSITIVE_FILE');

  // readFile joins lines and does not preserve the final newline.
  assert.equal((await workspace.readFile({ path: '.env.example' })).content, 'SECRET=');
  assert.equal((await workspace.readFile({ path: '.env.sample' })).content, 'SECRET=');

  // Listings hide denied entries instead of advertising them.
  const rootListing = await workspace.listDirectory({});
  const names = rootListing.entries.map((entry) => entry.name);
  assert.ok(!names.includes('.env'), '.env must not appear in a listing');
  assert.ok(!names.includes('id_rsa'), 'id_rsa must not appear in a listing');
  assert.ok(names.includes('.env.example'), '.env.example stays visible');

  // An explicit opt-in lifts the deny list, and only then.
  const permissive = await Workspace.create({ root: workspace.root, limits: { allowSensitive: true } });
  assert.equal((await permissive.readFile({ path: '.env' })).content, 'SECRET=hunter2');
});

/* --------------------------------------------------------------- ignore --- */

test('loadIgnoreMatcher honours comments, negation and directory rules', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write(
    '.c2cignore',
    ['# build output', 'dist/', '*.log', '!keep.log', 'nested/*.tmp', '', '!dist/keep.txt'].join('\n'),
  );

  const matcher = await loadIgnoreMatcher(workspace.root);
  assert.equal(await matcher('dist/'), true);
  assert.equal(await matcher('dist/bundle.js'), true);
  assert.equal(await matcher('dist/keep.txt'), false, 'negation wins for the re-included file');
  assert.equal(await matcher('keep.log'), false);
  assert.equal(await matcher('other.log'), true);
  assert.equal(await matcher('nested/a.tmp'), true);
  // A pattern containing a slash is anchored at the root and `*` stops at `/`,
  // so a deeper file keeps gitignore semantics and is not matched.
  assert.equal(await matcher('nested/deep/a.tmp'), false);
  assert.equal(await matcher('src/app.js'), false);
  // A `dir/` rule must not match a plain file that merely shares the name.
  assert.equal(await matcher('dist'), false);
});

test('.c2cignore filters listings and searches', async (t) => {
  const { workspace, write } = await makeWorkspace(t, { useRipgrep: false });
  await write('.c2cignore', 'build/\n!build/keep.txt\n*.log\n');
  await write('src/app.js', 'needle in app\n');
  await write('build/bundle.js', 'needle in bundle\n');
  await write('build/keep.txt', 'needle in kept file\n');
  await write('debug.log', 'needle in log\n');

  const listing = await workspace.listDirectory({});
  const names = listing.entries.map((entry) => entry.name);
  assert.ok(names.includes('src'));
  assert.ok(!names.includes('build'), 'ignored directory must be hidden');
  assert.ok(!names.includes('debug.log'), 'ignored file must be hidden');

  const result = await workspace.search({ query: 'needle' });
  const paths = result.matches.map((match) => match.path);
  assert.deepEqual(paths, ['src/app.js']);
});

/* -------------------------------------------------------------- readFile --- */

test('readFile returns the whole file with line metadata', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('lines.txt', 'alpha\nbravo\ncharlie\ndelta\n');

  const result = await workspace.readFile({ path: 'lines.txt' });
  assert.equal(result.path, 'lines.txt');
  assert.equal(result.content, 'alpha\nbravo\ncharlie\ndelta');
  assert.equal(result.startLine, 1);
  assert.equal(result.endLine, 4);
  assert.equal(result.totalLines, 4);
  assert.equal(result.binary, false);
  assert.equal(result.truncated, false);
  assert.equal(result.bytes, Buffer.byteLength(result.content));
});

test('readFile honours startLine/endLine windows', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('lines.txt', 'one\ntwo\nthree\nfour\nfive\n');

  const window = await workspace.readFile({ path: 'lines.txt', startLine: 2, endLine: 4 });
  assert.equal(window.content, 'two\nthree\nfour');
  assert.equal(window.startLine, 2);
  assert.equal(window.endLine, 4);
  assert.equal(window.totalLines, 5);

  const tail = await workspace.readFile({ path: 'lines.txt', startLine: 4 });
  assert.equal(tail.content, 'four\nfive');
  assert.equal(tail.endLine, 5);

  const beyond = await workspace.readFile({ path: 'lines.txt', startLine: 99, endLine: 120 });
  assert.equal(beyond.content, '');
  assert.equal(beyond.startLine, 99);
  assert.equal(beyond.endLine, 98);
  assert.equal(beyond.totalLines, 5);
});

test('readFile truncates at maxBytes and reports it', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('lines.txt', 'one\ntwo\nthree\nfour\n');

  const result = await workspace.readFile({ path: 'lines.txt', maxBytes: 5 });
  assert.ok(result.bytes <= 5, `bytes ${result.bytes} must not exceed the cap`);
  assert.equal(result.truncated, true);
  assert.equal(result.bytes, Buffer.byteLength(result.content));
  assert.ok(result.content.length > 0);

  // maxBytes is capped by the workspace limit, not allowed to exceed it.
  const tiny = await Workspace.create({ root: workspace.root, limits: { maxReadBytes: 4 } });
  const capped = await tiny.readFile({ path: 'lines.txt', maxBytes: 4096 });
  assert.ok(capped.bytes <= 4, `bytes ${capped.bytes} must not exceed maxReadBytes`);
  assert.equal(capped.truncated, true);
});

test('readFile flags binary content and reads nothing', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));

  const result = await workspace.readFile({ path: 'blob.bin' });
  assert.equal(result.binary, true);
  assert.equal(result.content, '');
  assert.equal(result.bytes, 5);
});

test('readFile reports NOT_FOUND and INVALID_ARGS for bad targets', async (t) => {
  const { workspace, mkdir } = await makeWorkspace(t);
  await mkdir('adir');
  await rejectsWithCode(async () => workspace.readFile({ path: 'missing.txt' }), 'NOT_FOUND');
  await rejectsWithCode(async () => workspace.readFile({ path: 'adir' }), 'INVALID_ARGS');
  await rejectsWithCode(async () => workspace.readFile({ path: '' }), 'INVALID_ARGS');
});

/* --------------------------------------------------------- listDirectory --- */

test('listDirectory lists one level with metadata', async (t) => {
  const { workspace, write, mkdir } = await makeWorkspace(t);
  await write('a.txt', 'aaa');
  await write('b.txt', 'bb');
  await mkdir('src');

  const listing = await workspace.listDirectory({});
  assert.equal(listing.path, '.');
  assert.equal(listing.total, 3);
  assert.equal(listing.truncated, false);
  const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('a.txt').type, 'file');
  assert.equal(byName.get('a.txt').size, 3);
  assert.match(byName.get('a.txt').mtime, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(byName.get('src').type, 'dir');
});

test('listDirectory paginates with total and truncated', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  for (let index = 0; index < 5; index += 1) {
    await write(`many/${String(index).padStart(2, '0')}.txt`, 'x');
  }

  const first = await workspace.listDirectory({ path: 'many', limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.total, 5);
  assert.equal(first.truncated, true);
  assert.deepEqual(
    first.entries.map((entry) => entry.name),
    ['00.txt', '01.txt'],
  );

  const second = await workspace.listDirectory({ path: 'many', limit: 2, offset: 2 });
  assert.deepEqual(
    second.entries.map((entry) => entry.name),
    ['02.txt', '03.txt'],
  );
  assert.equal(second.truncated, true);

  const last = await workspace.listDirectory({ path: 'many', limit: 2, offset: 4 });
  assert.deepEqual(
    last.entries.map((entry) => entry.name),
    ['04.txt'],
  );
  assert.equal(last.truncated, false);
});

test('listDirectory respects depth and the entry cap', async (t) => {
  const { workspace, write } = await makeWorkspace(t, { maxListEntries: 3 });
  await write('a/b/c.txt', 'c');
  await write('a/b/d.txt', 'd');

  const shallow = await workspace.listDirectory({ path: '.', depth: 1 });
  assert.deepEqual(
    shallow.entries.map((entry) => entry.path),
    ['a'],
  );

  const deep = await workspace.listDirectory({ path: '.', depth: 3 });
  assert.deepEqual(
    deep.entries.map((entry) => entry.path),
    ['a', 'a/b', 'a/b/c.txt'],
  );
  assert.equal(deep.truncated, true);
});

/* ---------------------------------------------------------------- search --- */

test('search falls back to the bounded Node walk without ripgrep', async (t) => {
  const { workspace, write } = await makeWorkspace(t, { useRipgrep: false });
  await write('src/app.js', 'const needle = 1;\nconst other = 2;\n');
  await write('src/util.js', '// no hit here\n');
  await write('docs/readme.md', 'needle in docs\n');
  await write('.env', 'NEEDLE=hidden\n');

  const plain = await workspace.search({ query: 'needle' });
  assert.equal(plain.engine, 'node');
  assert.equal(plain.total, 2);
  assert.deepEqual(
    plain.matches.map((match) => `${match.path}:${match.line}`),
    ['docs/readme.md:1', 'src/app.js:1'],
  );
  assert.ok(!plain.matches.some((match) => match.path === '.env'), 'sensitive files stay unsearchable');

  const sensitive = await workspace.search({ query: 'needle', caseSensitive: true });
  assert.equal(sensitive.total, 2);

  const upper = await workspace.search({ query: 'NEEDLE', caseSensitive: true });
  assert.equal(upper.total, 0, 'case-sensitive search must not fold case');

  const regex = await workspace.search({ query: 'const\\s+\\w+', regex: true });
  assert.ok(regex.matches.length >= 1);

  const globbed = await workspace.search({ query: 'needle', glob: '*.md' });
  assert.deepEqual(
    globbed.matches.map((match) => match.path),
    ['docs/readme.md'],
  );

  const limited = await workspace.search({ query: 'needle', limit: 1 });
  assert.equal(limited.matches.length, 1);
  assert.equal(limited.total, 2);
  assert.equal(limited.truncated, true);

  await rejectsWithCode(async () => workspace.search({ query: '' }), 'INVALID_ARGS');
  await rejectsWithCode(async () => workspace.search({ query: '([' , regex: true }), 'INVALID_ARGS');
});

test('search skips binaries and honours a default-limits workspace', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('binary.bin', Buffer.from([0x00, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
  await write('text.txt', 'needle\n');

  const result = await workspace.search({ query: 'needle' });
  assert.ok(result.engine === 'rg' || result.engine === 'node');
  assert.deepEqual(
    result.matches.map((match) => match.path),
    ['text.txt'],
  );
});

/* -------------------------------------------------------------- readImage --- */

test('readImage returns base64 and MIME type for a PNG', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  const buffer = Buffer.from(PNG_BASE64, 'base64');
  await write('pixel.png', buffer);

  const result = await workspace.readImage({ path: 'pixel.png' });
  assert.equal(result.path, 'pixel.png');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.base64, PNG_BASE64);
  assert.equal(result.bytes, buffer.length);
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
});

test('readImage rejects SVG and oversized files', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write('drawing.svg', SVG_SOURCE);

  const error = await rejectsWithCode(async () => workspace.readImage({ path: 'drawing.svg' }), 'UNSUPPORTED_IMAGE');
  assert.equal(error.mimeType, 'image/svg+xml');

  await write('camouflage.txt', SVG_SOURCE);
  await rejectsWithCode(async () => workspace.readImage({ path: 'camouflage.txt' }), 'UNSUPPORTED_IMAGE');

  await write('pixel.png', Buffer.from(PNG_BASE64, 'base64'));
  await rejectsWithCode(async () => workspace.readImage({ path: 'pixel.png', maxBytes: 8 }), 'TOO_LARGE');
  await rejectsWithCode(async () => workspace.readImage({ path: 'missing.png' }), 'NOT_FOUND');
});

/* ------------------------------------------------------------------ info --- */

test('info summarizes a Node project', async (t) => {
  const { workspace, write } = await makeWorkspace(t);
  await write(
    'package.json',
    JSON.stringify({
      name: 'demo-app',
      description: 'A demo project',
      dependencies: { react: '^19.0.0' },
    }),
  );
  await write('src/index.tsx', 'export const App = () => null;\n');
  await write('src/util.ts', 'export const one = 1;\n');

  const info = await workspace.info();
  assert.equal(info.name, path.basename(workspace.root));
  assert.equal(info.root, workspace.root);
  assert.equal(info.description, 'A demo project');
  assert.equal(info.projectType, 'node');
  assert.ok(info.languages.includes('TypeScript'), `languages: ${info.languages.join(', ')}`);
  assert.ok(info.frameworks.includes('React'), `frameworks: ${info.frameworks.join(', ')}`);
  assert.equal(typeof info.git.available, 'boolean');
});

/* ------------------------------------------------------------------- git --- */

/**
 * Run git for fixture setup. Only `ignore`/`inherit` stdio is used: a confined
 * harness can refuse piped child processes, and those cases must skip, not fail.
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{ ok: boolean, status: number | null }}
 */
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
  return { ok: !result.error && result.status === 0, status: result.status };
}

/** @type {boolean} */
const GIT_AVAILABLE = runGit(['--version']).ok;

/**
 * Create a committed git repository in `root` without touching global config.
 * @param {string} root
 * @returns {boolean} true when the repository is ready
 */
function initRepo(root) {
  const identity = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User'];
  if (!runGit(['init', '--initial-branch=main'], root).ok && !runGit(['init'], root).ok) return false;
  return runGit([...identity, 'add', '.'], root).ok && runGit([...identity, 'commit', '-m', 'initial'], root).ok;
}

test('gitStatus reports branch and pending changes', async (t) => {
  if (!GIT_AVAILABLE) {
    t.skip('git is not available in this environment');
    return;
  }
  const { workspace, write } = await makeWorkspace(t);
  await write('tracked.txt', 'one\n');
  if (!initRepo(workspace.root)) {
    t.skip('git cannot create a repository here');
    return;
  }
  await write('tracked.txt', 'two\n');
  await write('fresh.txt', 'new\n');

  const status = await workspace.gitStatus();
  if (!status.available) {
    // A confined harness can block child processes; that is an environment
    // limitation, not a workspace bug.
    t.skip('git child processes are unavailable to Node here');
    return;
  }
  assert.equal(status.branch, 'main');
  assert.equal(status.clean, false);
  assert.ok(status.entries.some((entry) => entry.path === 'tracked.txt'));
  assert.ok(status.entries.some((entry) => entry.path === 'fresh.txt'));
  assert.equal(status.total, status.entries.length);

  const clean = await Workspace.create({ root: workspace.root });
  const original = runGit(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'stash', '--include-untracked'], workspace.root);
  if (original.ok) {
    const after = await clean.gitStatus();
    if (after.available) assert.equal(after.clean, true);
  }
});

test('gitDiff returns the working-tree diff and respects maxBytes', async (t) => {
  if (!GIT_AVAILABLE) {
    t.skip('git is not available in this environment');
    return;
  }
  const { workspace, write } = await makeWorkspace(t);
  await write('app.js', 'const value = 1;\n');
  if (!initRepo(workspace.root)) {
    t.skip('git cannot create a repository here');
    return;
  }
  await write('app.js', 'const value = 2;\n');

  const diff = await workspace.gitDiff();
  if (!diff.available) {
    t.skip('git child processes are unavailable to Node here');
    return;
  }
  assert.match(diff.content, /const value = 1;/);
  assert.match(diff.content, /const value = 2;/);
  assert.equal(diff.truncated, false);
  assert.equal(diff.bytes, Buffer.byteLength(diff.content));

  const windowed = await workspace.gitDiff({ path: 'app.js' });
  assert.match(windowed.content, /app\.js/);

  const tiny = await workspace.gitDiff({ maxBytes: 10 });
  assert.equal(tiny.truncated, true);
  assert.ok(tiny.bytes <= 10);

  const staged = await workspace.gitDiff({ staged: true });
  assert.equal(staged.available, true);
  assert.equal(staged.content, '');
});

test('gitStatus reports available:false outside a repository', async (t) => {
  if (!GIT_AVAILABLE) {
    t.skip('git is not available in this environment');
    return;
  }
  const { workspace, write } = await makeWorkspace(t);
  await write('plain.txt', 'not a repo\n');

  const status = await workspace.gitStatus();
  if (status.available) {
    // Some environments place the temp dir inside a working tree; the only
    // contract worth asserting then is the shape.
    assert.equal(typeof status.clean, 'boolean');
    assert.ok(Array.isArray(status.entries));
    return;
  }
  assert.equal(status.branch, null);
  assert.equal(status.clean, true);
  assert.deepEqual(status.entries, []);

  const diff = await workspace.gitDiff();
  assert.equal(diff.available, false);
  assert.equal(diff.content, '');
  assert.equal(diff.bytes, 0);
});
