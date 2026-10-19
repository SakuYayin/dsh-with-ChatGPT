// The [C2C] control protocol: tiny state messages between ChatGPT (planning and
// review) and DeepSeek Harness (execution). Control messages carry intent only —
// never diffs, logs or file bodies. ChatGPT pulls data through the MCP tools.

export const MAX_CONTROL_BYTES = 1024;

/** States ChatGPT may send back to DSH. */
export const PROTOCOL_STATES = Object.freeze(['INIT', 'PLAN', 'EXECUTING', 'EXECUTED', 'REVIEW', 'DONE', 'BLOCKED', 'ERROR', 'HANDOFF']);

/** States only the local side keeps (never sent as a `STATE:` line). */
export const LOCAL_CHECKPOINTS = Object.freeze(['INIT', 'PLAN_RECEIVED', 'EXECUTING', 'EXECUTED_LOCAL', 'EXECUTED_SENT', 'DONE', 'BLOCKED', 'ERROR']);

/** Sections required for each inbound state. */
const REQUIRED_SECTIONS = Object.freeze({
  INIT: [],
  PLAN: ['GOAL', 'ACTIONS', 'TESTS', 'SUCCESS_CRITERIA'],
  EXECUTED: ['RESULT'],
  DONE: ['SUMMARY'],
  BLOCKED: ['REASON'],
  HANDOFF: ['ORIGINAL_GOAL', 'PROGRESS', 'CURRENT_STATE', 'NEXT_EXPECTED_STEP'],
  ERROR: ['REASON'],
  REVIEW: [],
  EXECUTING: [],
});

const KNOWN_SECTIONS = Object.freeze([
  'GOAL', 'RATIONALE', 'ACTIONS', 'FILES_LIKELY_INVOLVED', 'TESTS', 'SUCCESS_CRITERIA',
  'RESULT', 'CHANGED_FILES', 'SUMMARY', 'REASON', 'NEEDS', 'ORIGINAL_GOAL', 'PROGRESS',
  'CURRENT_STATE', 'KNOWN_ISSUES', 'NEXT_EXPECTED_STEP', 'INSTRUCTION', 'NOTE',
]);

/** Create the task identifier used in every control message. */
export function createTaskId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(2));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `c2c_${hex}`;
}

function clean(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** Render `KEY:` sections in a stable order, dropping empty ones. */
function renderSections(order, fields) {
  const out = [];
  for (const key of order) {
    const value = clean(fields[key]);
    if (value === '') continue;
    if (key === 'ACTIONS') {
      const lines = value.split('\n').map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
      out.push(`ACTIONS:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`);
      continue;
    }
    out.push(`${key}:\n${value}`);
  }
  return out.join('\n\n');
}

/** Build the INIT message that opens a C2C task. */
export function buildInit({ taskId, iteration = 0, goal }) {
  return `[C2C]
STATE: INIT
TASK_ID: ${taskId}
ITERATION: ${iteration}

GOAL:
${clean(goal)}

INSTRUCTION:
Inspect the connected workspace through the DSH with ChatGPT connector.
Produce a C2C PLAN message.`;
}

/** Build the EXECUTED message sent after one implementation iteration. */
export function buildExecuted({ taskId, iteration, result = 'Execution finished.', changedFiles = 0, tests = 'not run' }) {
  return `[C2C]
STATE: EXECUTED
TASK_ID: ${taskId}
ITERATION: ${iteration}

RESULT:
${clean(result)}

CHANGED_FILES:
${Number(changedFiles) || 0}

TESTS:
${clean(tests)}

Please independently inspect the workspace and the current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.`;
}

/** Build a HANDOFF message after the original conversation was lost. */
export function buildHandoff({ taskId, iteration, originalGoal, progress, currentState, knownIssues, nextExpectedStep }) {
  return `[C2C]
STATE: HANDOFF
TASK_ID: ${taskId}
ITERATION: ${iteration}

${renderSections(['ORIGINAL_GOAL', 'PROGRESS', 'CURRENT_STATE', 'KNOWN_ISSUES', 'NEXT_EXPECTED_STEP'], {
    ORIGINAL_GOAL: originalGoal,
    PROGRESS: progress,
    CURRENT_STATE: currentState,
    KNOWN_ISSUES: knownIssues,
    NEXT_EXPECTED_STEP: nextExpectedStep,
  })}`;
}

/** Build a generic control message from named sections. */
export function buildControl({ state, taskId, iteration, fields = {} }) {
  const name = String(state ?? '').toUpperCase();
  if (!PROTOCOL_STATES.includes(name)) {
    const error = new Error(`unknown control state "${state}"`);
    error.code = 'INVALID_STATE';
    throw error;
  }
  const keys = [...Object.keys(fields).filter((key) => KNOWN_SECTIONS.includes(key)), 'NOTE'];
  const body = renderSections(keys, { ...fields, NOTE: fields.NOTE });
  return `[C2C]\nSTATE: ${name}\nTASK_ID: ${taskId}\nITERATION: ${Number(iteration) || 0}\n\n${body}`.trimEnd();
}

/**
 * Parse a `[C2C]` control message.
 * @returns {{ ok: boolean, reason?: string, state?: string, taskId?: string, iteration?: number, fields?: Record<string, string>, bytes: number }}
 */
export function parseControlMessage(text) {
  const raw = clean(text);
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (raw === '') return { ok: false, reason: 'EMPTY', bytes, text: raw };
  if (!raw.startsWith('[C2C]')) return { ok: false, reason: 'MISSING_HEADER', bytes, text: raw };
  if (bytes > MAX_CONTROL_BYTES) return { ok: false, reason: 'TOO_LARGE', bytes, limit: MAX_CONTROL_BYTES, text: raw };

  const lines = raw.split('\n');
  const headers = {};
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') { index += 1; break; }
    const match = /^([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) return { ok: false, reason: 'BAD_HEADER', bytes, line: index + 1 };
    headers[match[1]] = match[2].trim();
  }

  const fields = {};
  let current = null;
  const buffer = [];
  const flush = () => {
    if (current === null) return;
    fields[current] = clean(buffer.join('\n'));
  };
  for (; index < lines.length; index += 1) {
    const match = /^([A-Z][A-Z0-9_]*):\s*$/.exec(lines[index].trimEnd());
    if (match) {
      flush();
      current = match[1];
      buffer.length = 0;
      continue;
    }
    if (current !== null) buffer.push(lines[index]);
  }
  flush();

  const state = String(headers.STATE ?? '').toUpperCase();
  if (!PROTOCOL_STATES.includes(state)) {
    return { ok: false, reason: 'BAD_STATE', bytes, got: headers.STATE ?? null };
  }
  const taskId = headers.TASK_ID ?? null;
  if (!taskId) return { ok: false, reason: 'MISSING_TASK_ID', bytes };
  const iteration = Number.parseInt(String(headers.ITERATION ?? '0'), 10);
  if (!Number.isFinite(iteration) || iteration < 0) return { ok: false, reason: 'BAD_ITERATION', bytes };

  const missing = (REQUIRED_SECTIONS[state] ?? []).filter((key) => !fields[key]);
  if (missing.length > 0) {
    return { ok: false, reason: 'MISSING_SECTIONS', missing, bytes, state, taskId, iteration, fields, text: raw };
  }

  return { ok: true, state, taskId, iteration, fields, bytes, text: raw };
}

/**
 * Advance the local checkpoint from an inbound state.
 * @returns {{ localState: string, waitingFor: string|null, accepted: boolean, reason?: string }}
 */
export function advance(localState, incoming) {
  const local = LOCAL_CHECKPOINTS.includes(localState) ? localState : 'INIT';
  const state = String(incoming ?? '').toUpperCase();
  switch (state) {
    case 'PLAN':
      if (['EXECUTED_SENT', 'INIT', 'PLAN_RECEIVED', 'EXECUTING', 'EXECUTED_LOCAL'].includes(local)) {
        return { localState: 'PLAN_RECEIVED', waitingFor: null, accepted: true };
      }
      return { localState: 'ERROR', waitingFor: null, accepted: false, reason: `PLAN is not valid after ${local}` };
    case 'DONE':
      if (['EXECUTED_SENT', 'PLAN_RECEIVED', 'EXECUTING', 'EXECUTED_LOCAL'].includes(local)) {
        return { localState: 'DONE', waitingFor: null, accepted: true };
      }
      return { localState: 'ERROR', waitingFor: null, accepted: false, reason: `DONE is not valid after ${local}` };
    case 'BLOCKED':
    case 'ERROR':
      return { localState: state === 'ERROR' ? 'ERROR' : 'BLOCKED', waitingFor: 'USER', accepted: true };
    case 'HANDOFF':
      return { localState: local, waitingFor: null, accepted: true };
    default:
      return { localState: 'ERROR', waitingFor: null, accepted: false, reason: `state ${state} cannot be received from ChatGPT` };
  }
}

/** The 13-rule boot prompt for a new C2C conversation. */
export function buildBootPrompt({ workspaceName, connectorName, maxIterations = 12 }) {
  return `You are the planning and review layer for one local coding workspace. DeepSeek Harness (DSH) executes.

Workspace: ${workspaceName}
Connector (use this one only): ${connectorName}
Iteration budget: ${maxIterations}

Rules:
1. You have no shell, no editor and no write access. The connector is strictly read-only.
2. Never ask anyone to paste file bodies, diffs or logs. Read what you need through the connector.
3. Start with workspace_info, then inspect only the files that matter for the task.
4. Every control message starts with [C2C], then STATE/TASK_ID/ITERATION headers, then sections.
5. Keep every control message under 1 KB. Control messages carry intent, never content.
6. Post control messages with control_submit. A plain chat reply is not a control message.
7. States you send: PLAN, DONE, BLOCKED, ERROR, HANDOFF. DSH sends INIT and EXECUTED.
8. PLAN carries GOAL, RATIONALE, ACTIONS (numbered), FILES_LIKELY_INVOLVED, TESTS, SUCCESS_CRITERIA.
9. Be substantive: say why, name the files, say what to test. No empty one-liners, no 40-step epics.
10. After EXECUTED, verify independently: call git_diff, read the changed files, check test_status.
11. If execution_output lists a readable item for the iteration, list it then read it; when it is restricted, review from git_diff.
12. DONE carries SUMMARY. BLOCKED carries REASON and NEEDS. HANDOFF carries ORIGINAL_GOAL, PROGRESS, CURRENT_STATE, KNOWN_ISSUES, NEXT_EXPECTED_STEP.
13. Never assume success from a claim. Trust order on conflict: connector (current code) > HANDOFF > Project instructions > Project memory.

Answer the first task with a C2C PLAN message posted through control_submit.`;
}

/** Project instructions to paste into the ChatGPT Project settings. */
export function buildProjectInstructions({ workspaceName, projectType, languages, frameworks, connectorName }) {
  const kind = [projectType, [...languages].join(', '), [...frameworks].join(', ')].filter(Boolean).join(' / ');
  return `You are the planning and review layer for one local workspace. DeepSeek Harness executes.

This Project is bound only to:
- Workspace name: ${workspaceName}
- Kind: ${kind || 'unknown'}
- Connector (use this one only): ${connectorName}

When you call tools, use ONLY that connector. Do not use any other DSH connector.
If workspace_info names a different workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs and any released command output through that connector.
Never ask anyone to paste file bodies, diffs or logs. After EXECUTED, call
execution_output (list, then read) when a readable item exists; if status is
restricted, review from git instead. Never upload the repository into this
Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the brief,
re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and no
40-step epics. Use C2C control messages.`;
}

/** One-line verification prompt that proves the connector is bound to this workspace. */
export function buildVerifyPrompt(connectorName) {
  return `Use the "${connectorName}" connector: call workspace_info and read a hello-style top-level file. Reply with the workspace name.`;
}
