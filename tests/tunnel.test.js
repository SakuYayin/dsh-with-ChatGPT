// Tests for the cloudflared supervisor. Every case injects a fake spawner, so
// no real tunnel is ever launched and no network is touched.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  TunnelManager,
  TUNNEL_TIMEOUT_MS,
  WINDOWS_CLOUDFLARED,
  findTunnelUrl,
  resolveCloudflaredBinary,
  stripAnsi,
} from '../lib/tunnel.js';

/* ------------------------------------------------------------- fixtures --- */

/** A realistic colourised quick-tunnel banner, chunked the way a pipe delivers it. */
const BANNER_CHUNKS = [
  '\u001b[90m2024-05-01T12:00:00Z INF\u001b[0m Requesting new quick Tunnel on trycloudflare.com...\n',
  '\u001b[90m2024-05-01T12:00:02Z INF\u001b[0m +---------------------------------------------------------------+\n',
  '\u001b[90m2024-05-01T12:00:02Z INF\u001b[0m |  \u001b[1mYour quick Tunnel has been created! Visit it at\u001b[0m       |\n',
  '\u001b[90m2024-05-01T12:00:02Z INF\u001b[0m |  \u001b[36mhttps://brave-quiet-forest-1234.trycloudflare.com\u001b[0m  |\n',
  '\u001b[90m2024-05-01T12:00:02Z INF\u001b[0m +---------------------------------------------------------------+\n',
  '\u001b[90m2024-05-01T12:00:03Z INF\u001b[0m Registered tunnel connection connIndex=0\n',
];

/** Build a fake child process exposing the surface TunnelManager relies on. */
function makeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal ?? 'SIGTERM');
    child.killed = true;
    child.emit('exit', null, 'SIGTERM');
    return true;
  };
  return child;
}

/** A spawner that records calls and hands back a single fake child. */
function makeSpawner(options = {}) {
  const child = makeChild(options);
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    return child;
  };
  return { spawn, child, calls };
}

/** Store stub that faithfully mimics StateStore's observable surface. */
function makeStore() {
  const store = {
    state: { tunnel: { mode: 'quick', url: null, named: null, updatedAt: null } },
    initCalls: 0,
    persistCalls: 0,
    async init() {
      store.initCalls += 1;
    },
    async persist() {
      store.persistCalls += 1;
    },
    async update(mutator) {
      const next = mutator(store.state);
      store.persistCalls += 1;
      return next;
    },
  };
  return store;
}

/** A manager wired to a fake binary and fake spawner. */
function makeManager(overrides = {}) {
  const store = overrides.store ?? makeStore();
  const changes = [];
  const make = makeSpawner();
  const env = { ...(overrides.env ?? cleanEnv()) };
  const manager = new TunnelManager({
    store,
    config: { mode: 'quick', cwd: overrides.cwd ?? process.cwd(), ...overrides.config, env },
    log: null,
    localOrigin: 'http://127.0.0.1:43120',
    onChange: (status) => changes.push(status),
    spawn: overrides.spawn ?? make.spawn,
    resolveBinary: overrides.resolveBinary ?? (() => ({ path: 'C:\\fake\\cloudflared.exe', source: 'test' })),
  });
  return { manager, store, changes, spawner: make };
}

/** Ambient environment with the tunnel knobs removed, so tests stay deterministic. */
function cleanEnv() {
  const env = { ...process.env };
  delete env.C2C_TUNNEL_PROTOCOL;
  delete env.CLOUDFLARED_TOKEN;
  return env;
}

/** Emit the banner asynchronously, then resolve once start() has the URL. */
async function startWithBanner(manager, spawner, chunks = BANNER_CHUNKS) {
  const started = manager.start();
  await tick();
  for (const chunk of chunks) spawner.child.stderr.emit('data', Buffer.from(chunk, 'utf8'));
  return started;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* --------------------------------------------------------------- parsing --- */

describe('output parsing', () => {
  it('strips ANSI colour codes', () => {
    assert.equal(stripAnsi('\u001b[36mhttps://a-b.trycloudflare.com\u001b[0m'), 'https://a-b.trycloudflare.com');
    assert.equal(stripAnsi(42), '42');
    assert.equal(stripAnsi(null), '');
  });

  it('finds the first quick-tunnel URL and nothing else', () => {
    const banner = BANNER_CHUNKS.join('');
    assert.equal(findTunnelUrl(banner), 'https://brave-quiet-forest-1234.trycloudflare.com');
    assert.equal(findTunnelUrl('nothing here'), null);
    assert.equal(findTunnelUrl(undefined), null);
  });
});

/* ---------------------------------------------------------- binary lookup --- */

describe('resolveCloudflaredBinary', () => {
  it('prefers a configured path that exists', () => {
    const found = resolveCloudflaredBinary({
      config: { cloudflaredPath: 'D:\\tools\\cloudflared.exe' },
      platform: 'win32',
      exists: () => true,
      exec: () => {
        throw new Error('should not be consulted');
      },
    });
    assert.deepEqual(found, { path: 'D:\\tools\\cloudflared.exe', source: 'config' });
  });

  it('falls back to where/which when the configured path is absent', () => {
    const commands = [];
    const found = resolveCloudflaredBinary({
      config: { cloudflaredPath: 'D:\\missing\\cloudflared.exe' },
      platform: 'win32',
      exists: (file) => file === 'C:\\Users\\me\\bin\\cloudflared.exe',
      exec: (command) => {
        commands.push(command);
        return 'C:\\Users\\me\\bin\\cloudflared.exe\r\n';
      },
    });
    assert.deepEqual(commands, ['where']);
    assert.deepEqual(found, { path: 'C:\\Users\\me\\bin\\cloudflared.exe', source: 'path' });
  });

  it('uses `which` on non-Windows platforms', () => {
    const commands = [];
    resolveCloudflaredBinary({
      platform: 'linux',
      exists: () => true,
      exec: (command) => {
        commands.push(command);
        return '/usr/local/bin/cloudflared\n';
      },
    });
    assert.deepEqual(commands, ['which']);
  });

  it('falls back to the Windows install location', () => {
    const found = resolveCloudflaredBinary({
      config: {},
      platform: 'win32',
      exists: (file) => file === WINDOWS_CLOUDFLARED,
      exec: () => {
        throw new Error('not on PATH');
      },
    });
    assert.deepEqual(found, { path: WINDOWS_CLOUDFLARED, source: 'default' });
  });

  it('reports a stable code when nothing is installed', () => {
    const found = resolveCloudflaredBinary({
      config: {},
      platform: 'win32',
      exists: () => false,
      exec: () => {
        throw new Error('not on PATH');
      },
    });
    assert.equal(found.path, null);
    assert.equal(found.error, 'CLOUDFLARED_NOT_FOUND');
    assert.match(found.message, /cloudflared was not found/);
  });
});

/* ------------------------------------------------------------------ start --- */

describe('TunnelManager.start', () => {
  it('resolves the URL out of an ANSI-coloured banner', async () => {
    const { manager, store, changes, spawner } = makeManager();
    const started = await startWithBanner(manager, spawner);

    assert.deepEqual(started, { url: 'https://brave-quiet-forest-1234.trycloudflare.com' });
    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0].file, 'C:\\fake\\cloudflared.exe');
    assert.deepEqual(spawner.calls[0].args, [
      'tunnel',
      '--url',
      'http://127.0.0.1:43120',
      '--no-autoupdate',
    ]);
    assert.equal(spawner.calls[0].opts.cwd, process.cwd());
    assert.equal(spawner.calls[0].opts.windowsHide, true);

    const status = manager.status();
    assert.equal(status.running, true);
    assert.equal(status.url, 'https://brave-quiet-forest-1234.trycloudflare.com');
    assert.equal(status.mode, 'quick');
    assert.equal(typeof status.startedAt, 'string');
    assert.equal(status.error, null);
    assert.equal(status.state, 'running');
    assert.equal(status.pid, 4242);

    assert.equal(store.state.tunnel.url, 'https://brave-quiet-forest-1234.trycloudflare.com');
    assert.equal(store.state.tunnel.mode, 'quick');
    assert.equal(typeof store.state.tunnel.updatedAt, 'string');
    assert.ok(store.persistCalls > 0);
    assert.ok(changes.length > 0);
    assert.equal(changes.at(-1).state, 'running');
  });

  it('survives the URL arriving split across chunks on stdout', async () => {
    const { manager, spawner } = makeManager();
    const started = manager.start();
    await tick();
    spawner.child.stdout.emit('data', Buffer.from('INF |  https://split-name-8848.trycl', 'utf8'));
    spawner.child.stdout.emit('data', Buffer.from('oudflare.com  |\n', 'utf8'));
    assert.deepEqual(await started, { url: 'https://split-name-8848.trycloudflare.com' });
  });

  it('adds --protocol http2 only when C2C_TUNNEL_PROTOCOL says so', async () => {
    const withHttp2 = makeManager({ env: { ...cleanEnv(), C2C_TUNNEL_PROTOCOL: 'http2' } });
    await startWithBanner(withHttp2.manager, withHttp2.spawner);
    assert.deepEqual(withHttp2.spawner.calls[0].args.slice(4), ['--protocol', 'http2']);
    await withHttp2.manager.stop();

    const plain = makeManager();
    await startWithBanner(plain.manager, plain.spawner);
    assert.equal(plain.spawner.calls[0].args.includes('--protocol'), false);
    await plain.manager.stop();
  });

  it('times out with TUNNEL_TIMEOUT when no URL is printed', async () => {
    const { manager, spawner } = makeManager({ config: { timeoutMs: 25 } });
    const started = manager.start();
    await tick();
    spawner.child.stderr.emit('data', Buffer.from('INF starting tunnel\n', 'utf8'));

    await assert.rejects(started, (error) => {
      assert.equal(error.code, 'TUNNEL_TIMEOUT');
      assert.match(error.message, /did not publish a tunnel URL/);
      assert.deepEqual(error.stderrTail, ['INF starting tunnel']);
      return true;
    });
    assert.equal(spawner.child.killed, true);
    assert.equal(manager.status().running, false);
    assert.equal(manager.status().errorCode, 'TUNNEL_TIMEOUT');
  });

  it('exports the documented 45 second default', () => {
    assert.equal(TUNNEL_TIMEOUT_MS, 45_000);
  });

  it('returns {url:null, error} when cloudflared is missing instead of throwing', async () => {
    const { manager, spawner } = makeManager({
      resolveBinary: () => ({
        path: null,
        error: 'CLOUDFLARED_NOT_FOUND',
        message: 'cloudflared was not found on PATH.',
      }),
    });
    const started = await manager.start();
    assert.deepEqual(started, { url: null, error: 'CLOUDFLARED_NOT_FOUND' });
    assert.equal(spawner.calls.length, 0);
    const status = manager.status();
    assert.equal(status.running, false);
    assert.equal(status.url, null);
    assert.match(status.error, /cloudflared was not found/);
    assert.equal(status.errorCode, 'CLOUDFLARED_NOT_FOUND');
  });

  it('returns {url:null, error} when the spawner throws', async () => {
    const { manager } = makeManager({
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    const started = await manager.start();
    assert.deepEqual(started, { url: null, error: 'CLOUDFLARED_SPAWN_FAILED' });
    assert.match(manager.status().error, /ENOENT/);
  });

  it('rejects when the child exits before publishing a URL', async () => {
    const { manager, spawner } = makeManager();
    const started = manager.start();
    await tick();
    spawner.child.stderr.emit('data', Buffer.from('ERR failed to connect\n', 'utf8'));
    spawner.child.emit('exit', 1, null);

    await assert.rejects(started, (error) => {
      assert.equal(error.code, 'TUNNEL_EXITED');
      assert.match(error.message, /code 1/);
      return true;
    });
  });

  it('is idempotent while a start is in flight', async () => {
    const { manager, spawner } = makeManager();
    const first = manager.start();
    const second = manager.start();
    await tick();
    for (const chunk of BANNER_CHUNKS) spawner.child.stderr.emit('data', Buffer.from(chunk, 'utf8'));
    await first;
    await second;
    assert.equal(spawner.calls.length, 1);
  });
});

/* ----------------------------------------------------------------- stop --- */

describe('TunnelManager.stop', () => {
  it('kills the child, clears the URL and persists the stopped record', async () => {
    const { manager, store, changes, spawner } = makeManager();
    await startWithBanner(manager, spawner);
    assert.equal(manager.status().running, true);

    const status = await manager.stop();
    assert.equal(spawner.child.killed, true);
    assert.ok(spawner.child.signals.includes('SIGTERM'));
    assert.equal(status.running, false);
    assert.equal(status.url, null);
    assert.equal(status.startedAt, null);
    assert.equal(status.error, null);
    assert.equal(status.state, 'stopped');
    assert.equal(store.state.tunnel.url, null);
    assert.equal(changes.at(-1).running, false);
  });

  it('is safe to call when nothing is running', async () => {
    const { manager } = makeManager();
    const status = await manager.stop();
    assert.equal(status.running, false);
    assert.equal(status.url, null);
  });

  it('rejects a start that is still waiting for a URL', async () => {
    const { manager, spawner } = makeManager();
    const started = manager.start();
    await tick();
    await manager.stop();
    await assert.rejects(started, (error) => error.code === 'TUNNEL_STOPPED');
  });
});

/* ---------------------------------------------------------------- choose --- */

describe('TunnelManager.choose', () => {
  it('persists the selected mode and hostname', async () => {
    const { manager, store } = makeManager();
    const status = await manager.choose({ mode: 'named', hostname: 'https://mcp.example.com/path' });

    assert.equal(status.mode, 'named');
    assert.equal(status.named, 'mcp.example.com');
    assert.equal(store.state.tunnel.mode, 'named');
    assert.equal(store.state.tunnel.named, 'mcp.example.com');
    assert.equal(store.state.tunnel.url, null);
    assert.equal(typeof store.state.tunnel.updatedAt, 'string');
  });

  it('clears the hostname when switching back to quick', async () => {
    const { manager, store } = makeManager();
    await manager.choose({ mode: 'named', hostname: 'mcp.example.com' });
    const status = await manager.choose({ mode: 'quick' });
    assert.equal(status.mode, 'quick');
    assert.equal(status.named, null);
    assert.equal(store.state.tunnel.named, null);
  });

  it('rejects an unknown mode with a coded error', async () => {
    const { manager } = makeManager();
    await assert.rejects(manager.choose({ mode: 'carrier-pigeon' }), (error) => error.code === 'TUNNEL_MODE_INVALID');
  });

  it('turns the tunnel off without spawning anything', async () => {
    const { manager, spawner, store } = makeManager();
    const status = await manager.choose({ mode: 'off' });
    assert.equal(status.mode, 'off');
    assert.equal(spawner.calls.length, 0);
    assert.equal(store.state.tunnel.mode, 'off');
    assert.deepEqual(await manager.start(), { url: null, error: 'TUNNEL_DISABLED' });
    assert.equal(spawner.calls.length, 0);
  });
});

/* ----------------------------------------------------------- tail buffer --- */

describe('stderrTail', () => {
  it('keeps only the last twenty lines', async () => {
    const { manager, spawner } = makeManager();
    const started = manager.start();
    await tick();
    for (let index = 0; index < 30; index += 1) {
      spawner.child.stderr.emit('data', Buffer.from(`line ${index}\n`, 'utf8'));
    }
    // 30 numbered lines then the banner line: the ring keeps the newest twenty.
    spawner.child.stderr.emit('data', Buffer.from('https://tail-check-9999.trycloudflare.com\n', 'utf8'));
    await started;

    const tail = manager.status().stderrTail;
    assert.equal(tail.length, 20);
    assert.equal(tail[0], 'line 11');
    assert.equal(tail.at(-1), 'https://tail-check-9999.trycloudflare.com');
  });
});
