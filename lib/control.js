// Queue of [C2C] control messages between ChatGPT and DeepSeek Harness.
//
// Direction A (inbound): ChatGPT posts PLAN / DONE / BLOCKED / HANDOFF through the
// `control_submit` MCP tool. The harness agent drains them with `control_inbox`.
// Direction B (outbound): the harness agent records INIT / EXECUTED so ChatGPT can
// see them through the `c2c://control/pending` resource and `control_inbox`.
//
// Nothing here touches the workspace: messages live in the plugin state directory.

import { nowIso, randomId, truncate } from './util.js';
import { MAX_CONTROL_BYTES, PROTOCOL_STATES, parseControlMessage } from './c2c.js';

/** States ChatGPT is allowed to send us. */
const INBOUND_STATES = Object.freeze(['PLAN', 'DONE', 'BLOCKED', 'ERROR', 'HANDOFF']);

const MAX_KEPT = 200;

/**
 * Durable, bounded control-message queue.
 */
export class ControlHub {
  constructor({ store, log }) {
    this.store = store;
    this.log = log;
    /** @type {Array<object>} */
    this.messages = [];
    this.seq = 0;
    this.ready = null;
  }

  /** Load persisted messages. Safe to call more than once. */
  init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const rows = await this.store.readJsonl('control.jsonl', MAX_KEPT);
      this.messages = rows.filter((row) => row && typeof row === 'object');
      this.seq = this.messages.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0);
      return this;
    })();
    return this.ready;
  }

  /** Accept a control message from ChatGPT. Never throws for bad input. */
  async submit({ message }) {
    await this.init();
    const parsed = parseControlMessage(message);
    if (!parsed.ok) {
      return {
        accepted: false,
        reason: parsed.reason,
        missing: parsed.missing ?? null,
        limit: parsed.limit ?? null,
        bytes: parsed.bytes,
        hint: parsed.reason === 'MISSING_HEADER'
          ? 'The message must start with the literal token [C2C] on its own line.'
          : parsed.reason === 'TOO_LARGE'
            ? `Control messages must stay under ${MAX_CONTROL_BYTES} bytes. Do not include diffs, logs or file bodies.`
            : parsed.reason === 'MISSING_SECTIONS'
              ? `Add the required sections: ${(parsed.missing ?? []).join(', ')}.`
              : 'Re-read the C2C message format and post the message again.',
      };
    }
    if (!INBOUND_STATES.includes(parsed.state)) {
      return {
        accepted: false,
        reason: 'NOT_INBOUND_STATE',
        state: parsed.state,
        hint: `DSH sends INIT and EXECUTED. ChatGPT sends ${INBOUND_STATES.join(', ')}.`,
      };
    }
    const record = {
      seq: this.seq + 1,
      id: randomId('ctl_'),
      at: nowIso(),
      direction: 'in',
      state: parsed.state,
      taskId: parsed.taskId,
      iteration: parsed.iteration,
      bytes: parsed.bytes,
      text: truncate(parsed.text ?? message, MAX_CONTROL_BYTES),
      consumedAt: null,
    };
    this.seq = record.seq;
    this.messages.push(record);
    this.trim();
    await this.store.appendJsonl('control.jsonl', record);
    return { accepted: true, message: publicMessage(record) };
  }

  /** Record an outbound message (INIT / EXECUTED / HANDOFF / note) for the record. */
  async recordOutbound({ message, kind = 'control' }) {
    await this.init();
    const text = String(message ?? '');
    const parsed = parseControlMessage(text);
    const record = {
      seq: this.seq + 1,
      id: randomId('ctl_'),
      at: nowIso(),
      direction: 'out',
      kind,
      state: parsed.ok ? parsed.state : null,
      taskId: parsed.taskId ?? null,
      iteration: parsed.iteration ?? null,
      bytes: Buffer.byteLength(text, 'utf8'),
      text: truncate(text, MAX_CONTROL_BYTES * 2),
      consumedAt: nowIso(),
    };
    this.seq = record.seq;
    this.messages.push(record);
    this.trim();
    await this.store.appendJsonl('control.jsonl', record);
    return publicMessage(record);
  }

  /** List pending inbound messages, optionally consuming them. */
  async inbox({ consume = false, limit = 10, state } = {}) {
    await this.init();
    const wanted = typeof state === 'string' && state !== '' ? state.toUpperCase() : null;
    const pending = this.messages
      .filter((row) => row.direction === 'in' && !row.consumedAt)
      .filter((row) => (wanted === null ? true : row.state === wanted))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
    if (consume && pending.length > 0) {
      const at = nowIso();
      for (const row of pending) row.consumedAt = at;
      for (const row of pending) await this.store.appendJsonl('control.jsonl', row);
    }
    return {
      pending: pending.map(publicMessage),
      total: this.messages.filter((row) => row.direction === 'in' && !row.consumedAt).length,
      consumed: consume ? pending.length : 0,
      states: INBOUND_STATES,
    };
  }

  /** The most recent inbound message, consumed or not. */
  latestInbound() {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const row = this.messages[index];
      if (row.direction === 'in') return publicMessage(row);
    }
    return null;
  }

  /** A compact session snapshot for the `c2c://control/pending` resource. */
  snapshot() {
    const pending = this.messages.filter((row) => row.direction === 'in' && !row.consumedAt);
    return {
      pendingCount: pending.length,
      pending: pending.slice(-5).map(publicMessage),
      latest: this.latestInbound(),
      knownStates: PROTOCOL_STATES,
    };
  }

  trim() {
    if (this.messages.length <= MAX_KEPT) return;
    this.messages = this.messages.slice(-MAX_KEPT);
  }
}

function publicMessage(row) {
  return {
    id: row.id,
    seq: row.seq,
    at: row.at,
    direction: row.direction,
    state: row.state,
    taskId: row.taskId,
    iteration: row.iteration,
    bytes: row.bytes,
    text: row.text,
    consumedAt: row.consumedAt ?? null,
  };
}
