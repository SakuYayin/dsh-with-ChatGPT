// Cloudflare tunnel supervisor. ChatGPT can only reach the bridge through a
// public https URL, so one cloudflared child turns the loopback MCP endpoint
// into a trycloudflare.com address. Quick tunnels have no API: the URL is
// scraped from the child's banner (which is ANSI-coloured on a TTY), so every
// state transition is published through `onChange` for the settings panel.
//
// Nothing is spawned at import time: `start()` is the only entry point.
import { execFileSync, spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { nowIso, truncate } from './util.js';

/** Default budget for cloudflared to print a URL before start() times out. */
export const TUNNEL_TIMEOUT_MS = 45_000;

/** Last-resort Windows install location when PATH and config have nothing. */
export const WINDOWS_CLOUDFLARED = 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED_PATTERN = /Registered tunnel connection|Connection [0-9a-f-]+ registered/i;
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_OUTPUT_CHARS = 32 * 1024;
const TAIL_LINES = 20;
const TAIL_LINE_CHARS = 400;
const DEFAULT_LOCAL_ORIGIN = 'http://127.0.0.1';

/* -------------------------------------------------------------- helpers --- */

/** Remove the colour codes cloudflared emits on a TTY. @param {unknown} text @returns {string} */
export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

/** First quick-tunnel URL in a chunk of cloudflared output, if any. @param {unknown} text @returns {string|null} */
export function findTunnelUrl(text) {
  const match = URL_PATTERN.exec(stripAnsi(text));
  return match === null ? null : match[0];
}

/**
 * Locate the cloudflared binary: configured path, then PATH (`which`/`where`),
 * then the Windows default install location.
 * @param {object} [options]
 * @param {object} [options.config] plugin config; `cloudflaredPath` wins.
 * @param {Record<string,string>} [options.env] environment (kept for symmetry).
 * @param {string} [options.platform] `process.platform` override (tests).
 * @param {Function} [options.exec] `execFileSync`-compatible lookup (tests).
 * @param {Function} [options.exists] `existsSync`-compatible probe (tests).
 * @returns {{path:string, source:string} | {path:null, error:string, message:string}}
 */
export function resolveCloudflaredBinary({ config = {}, env = process.env, platform = process.platform, exec = execFileSync, exists = existsSync } = {}) {
  void env;
  const configured = typeof config.cloudflaredPath === 'string' ? config.cloudflaredPath.trim() : '';
  if (configured !== '' && exists(configured)) return { path: configured, source: 'config' };

  const command = platform === 'win32' ? 'where' : 'which';
  try {
    const output = exec(command, ['cloudflared'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    const first = String(output ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
    if (first !== undefined && exists(first)) return { path: first, source: 'path' };
  } catch {
    // Not on PATH (or the lookup tool is unavailable): fall through.
  }

  if (platform === 'win32' && exists(WINDOWS_CLOUDFLARED)) return { path: WINDOWS_CLOUDFLARED, source: 'default' };

  const hint = configured === '' ? '' : ` The configured path "${configured}" does not exist.`;
  return {
    path: null,
    error: 'CLOUDFLARED_NOT_FOUND',
    message: `cloudflared was not found on PATH or in the default install location.${hint} Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and set config.cloudflaredPath if needed.`,
  };
}

/**
 * An Error carrying a stable `.code`, which is how the rest of the plugin
 * (and the tool layer) tells tunnel failures apart.
 * @param {string} code machine-readable reason.
 * @param {string} message human-readable detail.
 * @returns {Error & {code:string}}
 */
function tunnelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** @param {string} hostname @returns {string} bare lowercase host */
function normalizeHostname(hostname) {
  return String(hostname).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveNumber(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ---------------------------------------------------------------- class --- */

/**
 * Owns the single cloudflared child process. `start()` resolves as soon as the
 * public URL is known; `stop()` is always safe to call, including mid-start.
 */
export class TunnelManager {
  /**
   * @param {object} [options]
   * @param {object|null} [options.store] StateStore-like object (`state`, `init`, `persist`, `update`).
   * @param {object} [options.config] `{ cloudflaredPath, mode, cwd, env, timeoutMs, token, named }`.
   * @param {object|null} [options.log] `createLogger()` instance.
   * @param {string} [options.localOrigin] loopback origin cloudflared should expose.
   * @param {(status: object) => void} [options.onChange] called on every transition.
   * @param {Function} [options.spawn] test seam: `child_process.spawn`-compatible function.
   * @param {Function} [options.resolveBinary] test seam: returns `{ path, source }` or `{ path:null, error, message }`.
   */
  constructor({ store = null, config = {}, log = null, localOrigin = '', onChange = null, spawn = defaultSpawn, resolveBinary = null } = {}) {
    this.store = store;
    this.config = config ?? {};
    this.log = log;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.spawn = typeof spawn === 'function' ? spawn : defaultSpawn;
    this.env = this.config.env && typeof this.config.env === 'object' ? this.config.env : process.env;
    this.cwd = typeof this.config.cwd === 'string' && this.config.cwd.trim() !== '' ? this.config.cwd.trim() : process.cwd();
    this.localOrigin = typeof localOrigin === 'string' && localOrigin.trim() !== ''
      ? localOrigin.trim().replace(/\/+$/, '')
      : DEFAULT_LOCAL_ORIGIN;
    this.timeoutMs = positiveNumber(this.config.timeoutMs, TUNNEL_TIMEOUT_MS);
    this.mode = this.config.mode === 'named' ? 'named' : this.config.mode === 'off' ? 'off' : 'quick';
    this.named = typeof this.config.named === 'string' && this.config.named.trim() !== '' ? normalizeHostname(this.config.named) : null;
    // Config-file route for tokenless named tunnels: `--config <path>` + `run
    // <name>` resolves the credentials file from disk (cert.pem must exist next
    // to it). A token, when present, still takes precedence.
    this.configPath = typeof this.config.configPath === 'string' && this.config.configPath.trim() !== '' && existsSync(this.config.configPath.trim())
      ? this.config.configPath.trim()
      : null;
    this.tunnelName = typeof this.config.tunnelName === 'string' && this.config.tunnelName.trim() !== '' ? this.config.tunnelName.trim() : null;
    this.resolveBinary = typeof resolveBinary === 'function'
      ? resolveBinary
      : () => resolveCloudflaredBinary({ config: this.config, env: this.env, platform: process.platform });

    /** @type {object|null} */
    this.child = null;
    /** @type {{ resolve: Function, reject: Function }|null} */
    this.settle = null;
    /** @type {Promise<object>|null} */
    this.startPromise = null;
    /** @type {string[]} */
    this.stderrTail = [];
    this.partials = { stdout: '', stderr: '' };
    this.output = '';
    this.urlFound = false;
    this.stopping = false;
    this.state = { running: false, url: null, startedAt: null, phase: 'stopped', error: null, errorCode: null };
  }

  /* ------------------------------------------------------------ public --- */

  /**
   * Start the tunnel and resolve with the public URL.
   * Missing cloudflared never throws (the bridge keeps serving on loopback);
   * elapsed time or a dying child rejects with `.code` set.
   * @returns {Promise<{url: string|null, error?: string}>}
   */
  start() {
    if (this.startPromise !== null) return this.startPromise;
    this.startPromise = this.#launch().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  /**
   * Terminate the child, clear the published URL and persist the stopped state.
   * @returns {Promise<object>} the new status, for convenience.
   */
  async stop() {
    await this.#ready();
    const settle = this.settle;
    this.settle = null;
    const child = this.child;
    this.child = null;
    this.stopping = true;
    if (child !== null) this.#killChild(child);
    const wasRunning = this.state.running;
    this.state.running = false;
    this.state.url = null;
    this.state.startedAt = null;
    this.state.phase = wasRunning ? 'stopped' : 'off';
    this.state.error = null;
    this.state.errorCode = null;
    this.urlFound = false;
    await this.#persistTunnel(null);
    const status = this.#emit();
    this.stopping = false;
    if (settle !== null) settle.reject(tunnelError('TUNNEL_STOPPED', 'Tunnel stopped before a URL was available.'));
    return status;
  }

  /**
   * Persist a tunnel mode/hostname preference and restart when needed.
   * @param {{mode?: 'quick'|'named'|'off', hostname?: string|null}} [choice]
   * @returns {Promise<object>} the new status.
   */
  async choose({ mode, hostname = null } = {}) {
    await this.#ready();
    const nextMode = mode === 'quick' || mode === 'named' || mode === 'off' ? mode : null;
    if (nextMode === null) throw tunnelError('TUNNEL_MODE_INVALID', `unknown tunnel mode: ${String(mode)}`);
    const nextNamed = nextMode === 'named' && typeof hostname === 'string' && hostname.trim() !== ''
      ? normalizeHostname(hostname)
      : null;
    const changed = nextMode !== this.mode || nextNamed !== this.named;
    this.mode = nextMode;
    this.named = nextNamed;
    const wasRunning = this.state.running;
    await this.#persistTunnel(wasRunning && nextMode !== 'off' ? this.state.url : null);
    this.#emit();
    if (wasRunning && nextMode === 'off') {
      await this.stop();
    } else if (wasRunning && changed) {
      await this.stop();
      try {
        await this.start();
      } catch (error) {
        this.log?.warn?.(`tunnel restart failed: ${error?.message ?? error}`);
      }
    }
    return this.status();
  }

  /**
   * Snapshot for the settings panel and GET /api/state.
   * @returns {{mode:string, running:boolean, url:string|null, startedAt:string|null, error:string|null, errorCode:string|null, stderrTail:string[], state:string, named:string|null, pid:number|null}}
   */
  status() {
    return {
      mode: this.mode,
      running: this.state.running,
      url: this.state.url,
      startedAt: this.state.startedAt,
      error: this.state.error,
      errorCode: this.state.errorCode,
      stderrTail: this.stderrTail.slice(),
      state: this.state.phase,
      named: this.named,
      pid: this.child?.pid ?? null,
    };
  }

  /* ----------------------------------------------------------- internal --- */

  /** Load store state before the first write; never fatal. @returns {Promise<void>} */
  async #ready() {
    if (typeof this.store?.init !== 'function') return;
    try {
      await this.store.init();
    } catch (error) {
      this.log?.warn?.(`cannot load tunnel state: ${error?.message ?? error}`);
    }
  }

  /** @returns {Promise<{url:string|null, error?:string}>} */
  async #launch() {
    await this.#ready();
    if (this.state.running && this.state.url !== null) return { url: this.state.url };
    if (this.mode === 'off') {
      this.#markError('TUNNEL_DISABLED', 'Tunnel mode is off, so the bridge only answers on loopback.');
      this.#emit();
      return { url: null, error: 'TUNNEL_DISABLED' };
    }

    const resolved = this.#detectBinary();
    if (resolved === null || resolved.path === null || resolved.path === undefined) {
      const code = resolved?.error ?? 'CLOUDFLARED_NOT_FOUND';
      this.#markError(code, resolved?.message ?? 'cloudflared was not found; install it and retry.');
      this.#emit();
      return { url: null, error: code };
    }

    if (this.mode === 'named' && this.#token() === null && this.configPath === null) {
      this.#markError('CLOUDFLARED_TOKEN_MISSING', 'Named tunnel mode needs a tunnel token (config.token or CLOUDFLARED_TOKEN) or a config file (config.configPath).');
      this.#emit();
      return { url: null, error: 'CLOUDFLARED_TOKEN_MISSING' };
    }

    this.#resetOutput();
    this.state.error = null;
    this.state.errorCode = null;
    this.state.phase = 'starting';
    this.state.startedAt = nowIso();
    this.#emit();

    let child;
    try {
      child = this.spawn(resolved.path, this.#buildArgs(), this.#spawnOptions());
    } catch (error) {
      const message = `cloudflared failed to start: ${error?.message ?? error}`;
      this.#markError('CLOUDFLARED_SPAWN_FAILED', message);
      this.#emit();
      return { url: null, error: 'CLOUDFLARED_SPAWN_FAILED' };
    }
    if (child === null || child === undefined || typeof child.on !== 'function') {
      this.#markError('CLOUDFLARED_SPAWN_FAILED', 'cloudflared did not return a child process.');
      this.#emit();
      return { url: null, error: 'CLOUDFLARED_SPAWN_FAILED' };
    }
    this.child = child;
    this.log?.debug?.('cloudflared started', resolved.source ?? 'unknown', this.state.phase);
    return this.#awaitTunnel(child);
  }

  /**
   * Wire the child's streams and settle when a URL appears, the child dies or
   * the timeout elapses.
   * @param {object} child spawn result.
   * @returns {Promise<{url:string}>}
   */
  #awaitTunnel(child) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let outcome = null;
      const finish = (fn, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.settle !== null) this.settle = null;
        fn(value);
      };
      const fail = (code, message, { kill = false } = {}) => {
        if (finished || outcome === 'failed') return;
        outcome = 'failed';
        void (async () => {
          const error = tunnelError(code, message);
          error.stderrTail = this.stderrTail.slice();
          this.#markError(code, message);
          if (kill) this.#killChild(child);
          if (this.child === child) this.child = null;
          await this.#persistTunnel(null);
          this.#emit();
          finish(reject, error);
        })();
      };

      const timer = setTimeout(() => {
        fail('TUNNEL_TIMEOUT', `cloudflared did not publish a tunnel URL within ${Math.round(this.timeoutMs / 1000)} s.`, { kill: true });
      }, this.timeoutMs);
      timer.unref?.();

      this.settle = {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };

      const deliver = (url) => {
        if (finished || outcome !== null) return;
        outcome = 'running';
        void (async () => {
          try {
            await this.#establish(url);
          } catch (error) {
            this.log?.warn?.(`cannot persist tunnel URL: ${error?.message ?? error}`);
          }
          finish(resolve, { url });
        })();
      };
      const forward = (stream, name) => {
        if (stream === null || stream === undefined || typeof stream.on !== 'function') return;
        stream.on('data', (chunk) => {
          this.#ingest(chunk, name, deliver);
        });
      };
      forward(child.stdout, 'stdout');
      forward(child.stderr, 'stderr');

      child.on('exit', (code, signal) => {
        // stop() owns the settle path once it has decided to shut the child down.
        if (this.stopping) return;
        if (finished) {
          if (outcome === 'running') void this.#handleRuntimeExit(child, code, signal);
          return;
        }
        if (outcome === 'running') {
          void this.#handleRuntimeExit(child, code, signal);
          return;
        }
        const signalText = signal === null || signal === undefined ? '' : `, signal ${signal}`;
        const detail = this.stderrTail.slice(-6).join(' | ');
        fail('TUNNEL_EXITED', `cloudflared exited before publishing a URL (code ${code ?? 'null'}${signalText})${detail === '' ? '' : `: ${detail}`}`);
      });

      child.on('error', (error) => {
        if (finished) return;
        fail('CLOUDFLARED_SPAWN_FAILED', `cloudflared could not start: ${error?.message ?? error}`, { kill: true });
      });
    });
  }

  /** The child died after the URL was published: fold that into state. @returns {Promise<void>} */
  async #handleRuntimeExit(child, code, signal) {
    if (this.stopping || this.child !== child) return;
    this.child = null;
    const signalText = signal === null || signal === undefined ? '' : `, signal ${signal}`;
    this.#markError('TUNNEL_EXITED', `cloudflared stopped (code ${code ?? 'null'}${signalText}).`, 'stopped');
    await this.#persistTunnel(null);
    this.#emit();
  }

  /** Record the live URL and persist it. @param {string} url @returns {Promise<void>} */
  async #establish(url) {
    this.state.running = true;
    this.state.url = url;
    this.state.phase = 'running';
    this.state.error = null;
    this.state.errorCode = null;
    if (this.state.startedAt === null) this.state.startedAt = nowIso();
    await this.#persistTunnel(url);
    this.#emit();
  }

  /** @param {string} code @param {string} message @param {string} [phase] @returns {void} */
  #markError(code, message, phase = 'error') {
    this.state.running = false;
    this.state.url = null;
    this.state.phase = phase;
    this.state.error = message;
    this.state.errorCode = code;
  }

  /** @returns {object|null} resolved binary or `null` when detection threw. */
  #detectBinary() {
    try {
      return this.resolveBinary();
    } catch (error) {
      return {
        path: null,
        error: 'CLOUDFLARED_NOT_FOUND',
        message: `cloudflared detection failed: ${error?.message ?? error}`,
      };
    }
  }

  /** @returns {string|null} configured tunnel token, if any. */
  #token() {
    const configured = this.config.token ?? this.config.namedToken;
    if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
    for (const name of ['CLOUDFLARED_TOKEN', 'C2C_TUNNEL_TOKEN', 'TUNNEL_TOKEN']) {
      const value = this.env?.[name];
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  }

  /** @returns {string[]} cloudflared argv (binary excluded). */
  #buildArgs() {
    if (this.mode === 'named') {
      if (this.configPath !== null) {
        // Config-file run: `cloudflared tunnel --config <yml> run <name>`.
        // Flags must precede the `run` subcommand; the tokenless route uses the
        // credentials file referenced by the config plus cert.pem on disk.
        const configArgs = ['tunnel', '--config', this.configPath, '--no-autoupdate'];
        if (this.#protocol() !== null) configArgs.push('--protocol', this.#protocol());
        if (this.#token() !== null) {
          // A token still wins when present: token runs are remote-managed and
          // ignore the config file, so pass it the way cloudflared documents.
          configArgs.push('run', '--token', this.#token());
        } else if (this.tunnelName !== null) {
          configArgs.push('run', this.tunnelName);
        } else {
          configArgs.push('run');
        }
        return configArgs;
      }
      return ['tunnel', 'run', '--no-autoupdate'];
    }
    const args = ['tunnel', '--url', this.localOrigin, '--no-autoupdate'];
    if (this.#protocol() !== null) args.push('--protocol', this.#protocol());
    return args;
  }

  /** @returns {string|null} forced transport protocol from the env, if any. */
  #protocol() {
    const value = String(this.env?.C2C_TUNNEL_PROTOCOL ?? '').trim().toLowerCase();
    return value === '' ? null : value;
  }

  /** @returns {object} spawn options; the named mode passes its token by env. */
  #spawnOptions() {
    const options = { cwd: this.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (this.mode === 'named' && this.#token() !== null) {
      options.env = { ...this.env, TUNNEL_TOKEN: this.#token() ?? '' };
    }
    return options;
  }

  /** @param {object} child @returns {void} */
  #killChild(child) {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      this.log?.warn?.(`cannot signal cloudflared: ${error?.message ?? error}`);
    }
    if (process.platform === 'win32') {
      try {
        child.kill();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }

  /** Clear per-attempt parsing state. @returns {void} */
  #resetOutput() {
    this.stderrTail = [];
    this.partials = { stdout: '', stderr: '' };
    this.output = '';
    this.urlFound = false;
  }

  /**
   * Feed one stream chunk through ANSI stripping, the output scanner and the
   * stderr tail ring.
   * @param {unknown} chunk raw Buffer/string from the child.
   * @param {'stdout'|'stderr'} name origin stream.
   * @param {(url: string) => void} onUrl called once when a URL appears.
   * @returns {void}
   */
  #ingest(chunk, name, onUrl) {
    const text = stripAnsi(chunk);
    if (text === '') return;
    this.output = (this.output + text).slice(-MAX_OUTPUT_CHARS);
    const buffered = `${this.partials[name] ?? ''}${text}`;
    const lines = buffered.split(/\r?\n/);
    this.partials[name] = lines.pop() ?? '';
    for (const line of lines) this.#pushTail(line);
    if (this.urlFound) return;
    const quick = URL_PATTERN.exec(this.output);
    if (quick !== null) {
      this.urlFound = true;
      onUrl(quick[0]);
      return;
    }
    if (this.mode === 'named' && this.named !== null && REGISTERED_PATTERN.test(this.output)) {
      this.urlFound = true;
      onUrl(`https://${this.named}`);
    }
  }

  /** Push one diagnostic line, keeping the last {@link TAIL_LINES}. @param {string} line @returns {void} */
  #pushTail(line) {
    const text = truncate(String(line).trim(), TAIL_LINE_CHARS);
    if (text === '') return;
    this.stderrTail.push(text);
    if (this.stderrTail.length > TAIL_LINES) this.stderrTail.splice(0, this.stderrTail.length - TAIL_LINES);
  }

  /**
   * Persist `{mode,url,named,updatedAt}` into the shared state document.
   * @param {string|null} url published URL, `null` when stopped.
   * @returns {Promise<object>} the written record.
   */
  async #persistTunnel(url) {
    const record = { mode: this.mode, url: url ?? null, named: this.named, updatedAt: nowIso() };
    try {
      if (this.store === null || this.store === undefined) return record;
      if (typeof this.store.update === 'function') {
        await this.store.update((state) => {
          state.tunnel = { ...(state.tunnel ?? {}), ...record };
          return state.tunnel;
        });
      } else {
        if (this.store.state && typeof this.store.state === 'object') {
          this.store.state.tunnel = { ...(this.store.state.tunnel ?? {}), ...record };
        }
        if (typeof this.store.persist === 'function') await this.store.persist();
      }
    } catch (error) {
      this.log?.warn?.(`cannot persist tunnel state: ${error?.message ?? error}`);
    }
    return record;
  }

  /** Call `onChange` with a fresh snapshot; listener failures never escape. @returns {object} */
  #emit() {
    const status = this.status();
    this.log?.debug?.(`tunnel ${status.state}${status.url === null ? '' : ` ${status.url}`}${status.error === null ? '' : ` (${status.errorCode})`}`);
    if (this.onChange !== null) {
      try {
        this.onChange(status);
      } catch (error) {
        this.log?.warn?.(`tunnel onChange failed: ${error?.message ?? error}`);
      }
    }
    return status;
  }
}
