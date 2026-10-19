// Execution records: what the harness actually did in one iteration, plus the
// opt-in command output ChatGPT may read back through `execution_output`.
//
// Metadata is always readable. Output bodies go through a local sanitizer: an item
// is listed with `status: 'restricted'` and no body when it contains secrets, an
// implicit private key, or more than the configured size, so a careless log can
// never leak a credential into the ChatGPT conversation.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { nowIso, randomId, redactSecrets } from './util.js';

const MAX_METADATA_RECORDS = 500;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_LINES = 600;

/** Patterns that make an output body unreadable through the bridge. */
const HARD_DENY = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
]);

/**
 * Decide whether an output body may be released to ChatGPT.
 * @returns {{ released: boolean, reason?: string, text?: string, bytes?: number, truncated?: boolean }}
 */
export function sanitizeOutput(text, limits = {}) {
  const maxBytes = Number(limits.maxOutputBytes) > 0 ? Number(limits.maxOutputBytes) : DEFAULT_OUTPUT_BYTES;
  const maxLines = Number(limits.maxOutputLines) > 0 ? Number(limits.maxOutputLines) : DEFAULT_OUTPUT_LINES;
  const source = String(text ?? '');
  if (source.trim() === '') return { released: false, reason: 'EMPTY' };
  for (const pattern of HARD_DENY) {
    if (pattern.test(source)) return { released: false, reason: 'SECRET_DETECTED' };
  }
  const redacted = redactSecrets(source);
  const lines = redacted.split('\n');
  let truncated = false;
  let body = lines;
  if (lines.length > maxLines) {
    body = lines.slice(-maxLines);
    truncated = true;
  }
  let out = body.join('\n');
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = Buffer.from(out, 'utf8').subarray(-maxBytes).toString('utf8');
    truncated = true;
  }
  return { released: true, text: out, bytes: Buffer.byteLength(out, 'utf8'), truncated };
}

/**
 * Record one iteration of local execution.
 */
export class ExecutionJournal {
  constructor({ store, limits = {}, log }) {
    this.store = store;
    this.limits = limits;
    this.log = log;
    this.ready = null;
  }

  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await fsp.mkdir(this.store.dir('executions'), { recursive: true, mode: 0o700 });
      await fsp.mkdir(this.store.dir('outputs'), { recursive: true, mode: 0o700 });
      return this;
    })();
    return this.ready;
  }

  /**
   * Append an execution record. `output` is optional and stored separately so the
   * metadata stays cheap to read.
   */
  async record(input = {}) {
    await this.init();
    const taskId = String(input.taskId ?? input.task_id ?? '').trim() || 'c2c_unknown';
    const iteration = Math.max(0, Number.parseInt(String(input.iteration ?? 0), 10) || 0);
    const changedFiles = normalizeList(input.changedFiles ?? input.changed_files);
    const record = {
      id: randomId('exec_'),
      at: nowIso(),
      taskId,
      iteration,
      changedFiles,
      changedFileCount: changedFiles.length,
      tests: String(input.tests ?? '').trim() || 'not run',
      exitStatus: String(input.exitStatus ?? input.exit_status ?? 'unknown').toLowerCase(),
      command: input.command ? String(input.command).slice(0, 500) : null,
      exitCode: Number.isFinite(Number(input.exitCode ?? input.exit_code)) ? Number(input.exitCode ?? input.exit_code) : null,
      summary: input.summary ? String(input.summary).slice(0, 2000) : null,
      outputId: null,
    };

    if (input.output !== undefined && input.output !== null && String(input.output) !== '') {
      record.outputId = await this.writeOutput({ taskId, iteration, recordId: record.id, text: input.output });
    }

    await this.store.appendJsonl('executions/journal.jsonl', record);
    await this.store.update((state) => {
      state.counters.iterations = Math.max(Number(state.counters.iterations) || 0, iteration);
      state.session.iteration = iteration;
      state.session.taskId = taskId;
      return state;
    });
    return this.publicRecord(record);
  }

  /** Store an output body and decide whether it may be released. */
  async writeOutput({ taskId, iteration, recordId, text }) {
    await this.init();
    const verdict = sanitizeOutput(text, this.limits);
    const id = randomId('out_');
    const dir = this.store.dir(path.join('outputs', safeSegment(taskId), String(iteration)));
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.log`);
    const releaseVerdict = { ...verdict, id, file: path.relative(this.store.root, file), recordId };
    if (verdict.released) {
      await fsp.writeFile(file, verdict.text, { mode: 0o600 });
    }
    await this.store.appendJsonl('outputs/index.jsonl', {
      id,
      at: nowIso(),
      taskId,
      iteration,
      recordId,
      status: verdict.released ? 'readable' : 'restricted',
      reason: verdict.released ? null : verdict.reason,
      bytes: verdict.bytes ?? null,
      truncated: Boolean(verdict.truncated),
      file: path.relative(this.store.root, file),
    });
    return id;
  }

  /** Metadata for one iteration or a whole task. */
  async summary({ taskId, limit = 10 } = {}) {
    await this.init();
    const rows = await this.store.readJsonl('executions/journal.jsonl', MAX_METADATA_RECORDS);
    const filtered = taskId ? rows.filter((row) => row.taskId === taskId) : rows;
    const items = filtered.slice(-Math.max(1, Math.min(100, Number(limit) || 10)));
    return {
      taskId: taskId ?? null,
      iterations: items.map(this.publicRecord),
      latest: items.length > 0 ? this.publicRecord(items[items.length - 1]) : null,
      total: filtered.length,
    };
  }

  /** `list` or `read` an output body. */
  async output({ action = 'list', id, taskId, iteration } = {}) {
    await this.init();
    const index = await this.store.readJsonl('outputs/index.jsonl', MAX_METADATA_RECORDS);
    if (action === 'list') {
      const items = index
        .filter((row) => (taskId ? row.taskId === taskId : true))
        .filter((row) => (iteration === undefined || iteration === null ? true : Number(row.iteration) === Number(iteration)))
        .slice(-50)
        .map((row) => ({
          id: row.id,
          taskId: row.taskId,
          iteration: row.iteration,
          status: row.status,
          reason: row.reason ?? null,
          bytes: row.bytes ?? null,
          truncated: Boolean(row.truncated),
          at: row.at,
        }));
      return { action: 'list', total: items.length, items };
    }
    if (action !== 'read') {
      const error = new Error(`unknown execution_output action "${action}"`);
      error.code = 'INVALID_ARGS';
      throw error;
    }
    let row = id ? index.find((entry) => entry.id === id) : null;
    if (!row && (taskId || iteration)) {
      row = [...index]
        .reverse()
        .find((entry) => (taskId ? entry.taskId === taskId : true) && (iteration === undefined || iteration === null ? true : Number(entry.iteration) === Number(iteration)));
    }
    if (!row) {
      const error = new Error('no execution output recorded for that id/iteration');
      error.code = 'NOT_FOUND';
      throw error;
    }
    if (row.status !== 'readable') {
      return {
        action: 'read',
        id: row.id,
        status: row.status,
        reason: row.reason ?? 'RESTRICTED',
        text: null,
        note: 'This output body is withheld by the local sanitizer. Review the iteration from git_diff instead.',
      };
    }
    const absolute = path.resolve(this.store.root, row.file);
    if (!absolute.startsWith(path.resolve(this.store.root))) {
      const error = new Error('output path escaped the state directory');
      error.code = 'PATH_ESCAPE';
      throw error;
    }
    let text = '';
    try {
      text = await fsp.readFile(absolute, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { action: 'read', id: row.id, status: 'readable', text, bytes: Buffer.byteLength(text, 'utf8'), truncated: Boolean(row.truncated) };
  }

  /** Latest test/build status derived from the journal. */
  async testStatus() {
    const { latest } = await this.summary({ limit: 20 });
    if (!latest) return { available: false, note: 'No execution has been recorded yet.' };
    return {
      available: true,
      exitStatus: latest.exitStatus,
      tests: latest.tests,
      command: latest.command,
      exitCode: latest.exitCode,
      at: latest.at,
      taskId: latest.taskId,
      iteration: latest.iteration,
    };
  }

  publicRecord(row) {
    return {
      id: row.id,
      at: row.at,
      taskId: row.taskId,
      iteration: row.iteration,
      changedFiles: row.changedFiles ?? [],
      changedFileCount: row.changedFileCount ?? (row.changedFiles ?? []).length,
      tests: row.tests ?? 'not run',
      exitStatus: row.exitStatus ?? 'unknown',
      command: row.command ?? null,
      exitCode: row.exitCode ?? null,
      summary: row.summary ?? null,
      outputId: row.outputId ?? null,
    };
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 200);
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 200);
  }
  return [];
}

function safeSegment(value) {
  return String(value ?? 'task').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'task';
}
