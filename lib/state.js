// Durable plugin state. Everything lives outside the workspace, exactly like the
// upstream c2c CLI: the project never receives credentials or session files.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { nowIso, safeJsonParse } from './util.js';

export function stateRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-with-chatgpt');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function emptyState() {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    clients: {},
    codes: {},
    tokens: {},
    pairing: {
      code: null,
      createdAt: null,
      expiresAt: null,
      attempts: 0,
      consumed: false,
    },
    session: {
      taskId: null,
      iteration: 0,
      state: null,
      protocolState: null,
      waitingFor: null,
      goal: null,
      nextStep: null,
      knownIssues: null,
      chatUrl: null,
      projectUrl: null,
      connectorName: null,
      updatedAt: null,
    },
    tunnel: {
      mode: 'quick',
      url: null,
      named: null,
      updatedAt: null,
    },
    counters: {
      iterations: 0,
    },
  };
}

/**
 * A tiny write-through JSON store. The whole document is small (< 100 KB), so a
 * single file with an atomic replace keeps crash recovery trivial.
 */
export class StateStore {
  constructor(root = stateRoot()) {
    this.root = root;
    this.file = path.join(root, 'state.json');
    this.data = emptyState();
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  async init() {
    if (this.loaded) return this.data;
    await ensureDir(this.root);
    await ensureDir(path.join(this.root, 'executions'));
    await ensureDir(path.join(this.root, 'outputs'));
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      const parsed = safeJsonParse(text, null);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...emptyState(), ...parsed };
        // Nested objects need their defaults too: a partial file must not crash.
        for (const key of ['clients', 'codes', 'tokens', 'pairing', 'session', 'tunnel', 'counters']) {
          this.data[key] = { ...emptyState()[key], ...(parsed[key] ?? {}) };
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
    return this.data;
  }

  get state() {
    return this.data;
  }

  /** Serialized, atomic persist. Concurrent callers chain on this.queue. */
  persist() {
    this.queue = this.queue.then(async () => {
      this.data.updatedAt = nowIso();
      const tmp = `${this.file}.${process.pid}.tmp`;
      await ensureDir(this.root);
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    });
    return this.queue;
  }

  /** Mutate + persist in one awaited step. */
  async update(mutator) {
    const result = mutator(this.data);
    await this.persist();
    return result;
  }

  get session() {
    return this.data.session;
  }

  async updateSession(patch) {
    return this.update((state) => {
      state.session = { ...state.session, ...patch, updatedAt: nowIso() };
      return state.session;
    });
  }

  async clearCheckpoint() {
    return this.updateSession({
      state: null,
      protocolState: null,
      waitingFor: null,
      goal: null,
      nextStep: null,
      knownIssues: null,
    });
  }

  dir(name) {
    return path.join(this.root, name);
  }

  /** Append one JSON line, creating the file lazily. */
  async appendJsonl(name, record) {
    const file = path.join(this.root, name);
    await ensureDir(path.dirname(file));
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record;
  }

  async readJsonl(name, limit = 500) {
    const file = path.join(this.root, name);
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const start = Math.max(0, lines.length - limit);
    const out = [];
    for (let index = start; index < lines.length; index += 1) {
      const parsed = safeJsonParse(lines[index], null);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    }
    return out;
  }

  async writeText(name, text) {
    const file = path.join(this.root, name);
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, text, { mode: 0o600 });
    return file;
  }

  async readText(name, maxBytes = 512 * 1024) {
    const file = path.join(this.root, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.size > maxBytes) {
        const handle = await fsp.open(file, 'r');
        try {
          const buffer = Buffer.alloc(maxBytes);
          await handle.read(buffer, 0, maxBytes, 0);
          return { text: buffer.toString('utf8'), truncated: true, size: stat.size };
        } finally {
          await handle.close();
        }
      }
      return { text: await fsp.readFile(file, 'utf8'), truncated: false, size: stat.size };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  existsSync(name) {
    return fs.existsSync(path.join(this.root, name));
  }
}
