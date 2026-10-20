// Unit tests for lib/mcp.js — pure JSON-RPC dispatch against duck-typed fakes.
// No network, no filesystem, no npm dependencies: node:test + node:assert/strict.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TOOL_SPECS, createMcp } from '../lib/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from '../lib/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_FILE = path.join(HERE, '..', 'lib', 'mcp.js');

const EXPECTED_TOOLS = [
  'workspace_info',
  'list_directory',
  'read_file',
  'search_workspace',
  'git_status',
  'git_diff',
  'test_status',
  'execution_summary',
  'execution_output',
  'read_image',
  'control_submit',
  'control_inbox',
];

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Inert logger so tests never touch the console. */
function fakeLog() {
  const lines = [];
  const make = (level) => (...args) => lines.push([level, ...args]);
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), lines };
}

/**
 * Build a full duck-typed dependency set plus a call ledger.
 * Every method is overridable per test through `overrides`.
 */
function fakeDeps(overrides = {}) {
  const calls = [];
  const record = (name) => (args) => {
    calls.push({ name, args });
    return undefined;
  };

  const workspace = {
    info: async (args) => {
      calls.push({ name: 'info', args });
      return {
        name: 'demo',
        root: 'E:\\demo',
        projectType: 'node',
        languages: ['JavaScript'],
        frameworks: ['node:test'],
        git: { available: true, branch: 'main' },
      };
    },
    listDirectory: async (args) => {
      calls.push({ name: 'listDirectory', args });
      return {
        path: args.path,
        entries: [{ name: 'a.js', path: 'a.js', type: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z' }],
        total: 1,
        truncated: false,
      };
    },
    readFile: async (args) => {
      calls.push({ name: 'readFile', args });
      return {
        path: args.path,
        content: 'export const answer = 42;\n',
        startLine: args.startLine ?? 1,
        endLine: args.endLine ?? 1,
        totalLines: 1,
        bytes: 26,
        truncated: false,
        binary: false,
      };
    },
    search: async (args) => {
      calls.push({ name: 'search', args });
      return { query: args.query, matches: [{ path: 'a.js', line: 1, text: 'answer' }], total: 1, truncated: false, engine: 'node' };
    },
    gitStatus: async () => {
      calls.push({ name: 'gitStatus', args: undefined });
      return { available: true, branch: 'main', clean: true, entries: [], total: 0, truncated: false };
    },
    gitDiff: async (args) => {
      calls.push({ name: 'gitDiff', args });
      return { available: true, content: 'diff --git a/a.js b/a.js\n', truncated: false, bytes: 26 };
    },
    readImage: async (args) => {
      calls.push({ name: 'readImage', args });
      return { path: args.path, mimeType: 'image/png', base64: PNG_BASE64, bytes: 68 };
    },
  };

  const execution = {
    testStatus: async () => {
      calls.push({ name: 'testStatus', args: undefined });
      return { available: true, taskId: 'c2c_f81a', iteration: 1, tests: '27 passed', exitStatus: 'ok' };
    },
    summary: async (args) => {
      calls.push({ name: 'summary', args });
      return { records: [{ taskId: args.taskId ?? 'c2c_f81a', iteration: 1, tests: '27 passed', exitStatus: 'ok' }] };
    },
    output: async (args) => {
      calls.push({ name: 'output', args });
      if (args.action === 'read') return { action: 'read', id: args.id, text: 'tests passed' };
      return { action: 'list', items: [{ id: 'out_9f21', command: 'node --test', readable: true }] };
    },
    status: async () => {
      calls.push({ name: 'status', args: undefined });
      return { taskId: 'c2c_f81a', iteration: 2, state: 'EXECUTED', waitingFor: 'REVIEW' };
    },
  };

  const control = {
    submit: async (message) => {
      calls.push({ name: 'submit', args: message });
      return { ok: true, id: 'msg_1', bytes: Buffer.byteLength(message) };
    },
    inbox: async (args) => {
      calls.push({ name: 'inbox', args });
      return { messages: args.consume ? [] : [{ id: 'msg_1', text: '[C2C]\nSTATE: EXECUTED\nTASK_ID: c2c_f81a' }], consumed: args.consume === true };
    },
  };

  for (const [owner, patch] of Object.entries(overrides)) {
    if (patch === null || patch === undefined) {
      if (owner === 'workspace') Object.keys(workspace).forEach((key) => delete workspace[key]);
      if (owner === 'execution') Object.keys(execution).forEach((key) => delete execution[key]);
      if (owner === 'control') Object.keys(control).forEach((key) => delete control[key]);
      continue;
    }
    const target = { workspace, execution, control }[owner];
    if (target === undefined) throw new Error(`unknown dependency in overrides: ${owner}`);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete target[key];
      else target[key] = value;
    }
  }

  return { workspace, execution, control, calls, record };
}

function makeMcp(overrides = {}, options = {}) {
  const deps = fakeDeps(overrides);
  const mcp = createMcp({ ...deps, limits: options.limits, log: options.log ?? fakeLog() });
  return { mcp, ...deps };
}

let nextId = 1;

/** Send one request and return the JSON-RPC envelope. */
async function rpc(mcp, method, params) {
  const id = nextId;
  nextId += 1;
  const message = { jsonrpc: '2.0', id, method };
  if (params !== undefined) message.params = params;
  const response = await mcp.handle(message);
  assert.equal(response.id, id, 'response id must echo the request id');
  assert.equal(response.jsonrpc, '2.0');
  return response;
}

/** Call one tool and return the raw tools/call result (or the error object). */
async function callTool(mcp, name, args) {
  const response = await rpc(mcp, 'tools/call', { name, arguments: args ?? {} });
  if (response.error) return response;
  return response.result;
}

function textOf(result) {
  assert.ok(Array.isArray(result.content), 'result must have a content array');
  const block = result.content.find((entry) => entry.type === 'text');
  assert.ok(block, 'result must have a text content block');
  return block.text;
}

function jsonOf(result) {
  return JSON.parse(textOf(result));
}

/* -------------------------------------------------------------- catalogue --- */

test('TOOL_SPECS exposes exactly the 12 contract tools in order', () => {
  assert.ok(Array.isArray(TOOL_SPECS));
  assert.equal(TOOL_SPECS.length, 12);
  assert.deepEqual(TOOL_SPECS.map((spec) => spec.name), EXPECTED_TOOLS);
  assert.ok(Object.isFrozen(TOOL_SPECS), 'TOOL_SPECS is a readonly catalogue');
});

test('every tool spec has a non-empty description and a plain JSON-Schema object', () => {
  for (const spec of TOOL_SPECS) {
    assert.equal(typeof spec.name, 'string');
    assert.ok(spec.name.length > 0);
    assert.equal(typeof spec.description, 'string');
    assert.ok(spec.description.trim().length > 0, `${spec.name} needs a description`);
    assert.equal(typeof spec.inputSchema, 'object');
    assert.notEqual(spec.inputSchema, null);
    assert.equal(spec.inputSchema.type, 'object');
    assert.equal(typeof spec.inputSchema.properties, 'object');
    assert.ok(Array.isArray(spec.inputSchema.required), `${spec.name} must use a JSON Schema "required" array`);
    // DSH authoring style (required: true per property) must not leak into raw MCP schema.
    for (const [key, value] of Object.entries(spec.inputSchema.properties)) {
      assert.equal(typeof value, 'object', `${spec.name}.${key} must be a schema object`);
      assert.notEqual(value.required, true, `${spec.name}.${key} must not use per-property required:true`);
    }
    for (const requiredKey of spec.inputSchema.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(spec.inputSchema.properties, requiredKey), `${spec.name}.required lists unknown key ${requiredKey}`);
    }
  }
});

test('read-only tool descriptions say so and control_submit carries the exact required sentence', () => {
  const byName = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));
  const readOnly = EXPECTED_TOOLS.filter((name) => name !== 'control_submit');
  for (const name of readOnly) {
    assert.match(byName.get(name).description, /read-only/i, `${name} must state it is read-only`);
  }
  const controlSubmit = byName.get('control_submit');
  // The contract sentence is the tool's first line: it stays verbatim so
  // existing callers keep recognising the tool, and the shape guide follows it.
  assert.ok(
    controlSubmit.description.includes(
      'Control plane only. Does not modify the workspace. Post one `[C2C]` control message back to the local DSH harness.',
    ),
    'control_submit description must carry the contract sentence verbatim',
  );
  // Regression guard for the field failure: ChatGPT kept returning BAD_HEADER
  // because it wrote markdown (`**STATE:**`) and inline values. The description
  // must show the literal shape it is expected to emit.
  assert.ok(controlSubmit.description.includes('[C2C]'), 'control_submit must show the literal [C2C] header');
  assert.ok(controlSubmit.description.includes('STATE: PLAN'), 'control_submit must show a STATE header line');
  assert.ok(
    controlSubmit.description.includes('16 KiB'),
    'control_submit must state the byte budget',
  );
});

test('declared required arguments match the contract table', () => {
  const required = Object.fromEntries(TOOL_SPECS.map((spec) => [spec.name, spec.inputSchema.required]));
  assert.deepEqual(required.workspace_info, []);
  assert.deepEqual(required.list_directory, []);
  assert.deepEqual(required.read_file, ['path']);
  assert.deepEqual(required.search_workspace, ['query']);
  assert.deepEqual(required.git_status, []);
  assert.deepEqual(required.git_diff, []);
  assert.deepEqual(required.test_status, []);
  assert.deepEqual(required.execution_summary, []);
  assert.deepEqual(required.execution_output, ['action']);
  assert.deepEqual(required.read_image, ['path']);
  assert.deepEqual(required.control_submit, ['message']);
  assert.deepEqual(required.control_inbox, []);
});

test('execution_output declares an opaque STRING id, not an integer', () => {
  const spec = TOOL_SPECS.find((entry) => entry.name === 'execution_output');
  assert.equal(spec.inputSchema.properties.id.type, 'string', 'journal output ids are opaque strings (out_<hex>)');
  assert.equal(spec.inputSchema.properties.id.minimum, undefined);
  assert.match(spec.inputSchema.properties.id.description, /opaque string/i);
});

test('mcp.js does not import the concrete workspace/execution/control modules', async () => {
  const source = await readFile(MCP_FILE, 'utf8');
  for (const moduleName of ['./workspace.js', './execution.js', './control.js']) {
    assert.ok(!source.includes(moduleName), `mcp.js must stay duck-typed, found ${moduleName}`);
  }
  assert.match(source, /from '\.\/util\.js'/);
});

test('createMcp returns handle() and listTools(), and listTools() is a copy', () => {
  const { mcp } = makeMcp();
  assert.equal(typeof mcp.handle, 'function');
  assert.equal(typeof mcp.listTools, 'function');
  const tools = mcp.listTools();
  assert.equal(tools.length, 12);
  tools.pop();
  assert.equal(mcp.listTools().length, 12, 'mutating the returned array must not corrupt the catalogue');
});

/* ------------------------------------------------------------- initialize --- */

test('initialize echoes a known protocol version and advertises capabilities', async () => {
  const { mcp } = makeMcp();
  for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const response = await rpc(mcp, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'chatgpt' } });
    assert.equal(response.result.protocolVersion, version);
    assert.deepEqual(response.result.capabilities, {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    });
    assert.deepEqual(response.result.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
  }
});

test('initialize falls back to 2025-06-18 for unknown or missing versions', async () => {
  const { mcp } = makeMcp();
  for (const params of [{ protocolVersion: '1999-01-01' }, { protocolVersion: '   ' }, {}, undefined, { protocolVersion: 42 }]) {
    const response = await rpc(mcp, 'initialize', params);
    assert.equal(response.result.protocolVersion, '2025-06-18');
  }
});

test('ping answers with an empty result object', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'ping');
  assert.deepEqual(response.result, {});
});

/* ------------------------------------------------------------------ tools --- */

test('tools/list returns exactly 12 tools, each with an object inputSchema', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'tools/list');
  set: {
    const names = response.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, EXPECTED_TOOLS);
    for (const tool of response.result.tools) {
      assert.equal(typeof tool.inputSchema, 'object');
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description.trim().length > 0);
    }
  }
});

test('workspace_info happy path', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'workspace_info', {});
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).name, 'demo');
  assert.equal(calls.filter((call) => call.name === 'info').length, 1, 'workspace.info() must be called exactly once');
});

test('list_directory happy path passes pagination and depth', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'list_directory', { path: 'src', depth: 2, limit: 10, offset: 5 });
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).path, 'src');
  const call = calls.find((entry) => entry.name === 'listDirectory');
  assert.deepEqual(call.args, { path: 'src', depth: 2, limit: 10, offset: 5 });
});

test('list_directory defaults path to the workspace root', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'list_directory', {});
  assert.equal(result.isError, undefined);
  assert.equal(calls.find((entry) => entry.name === 'listDirectory').args.path, '.');
});

test('read_file happy path maps snake_case args to startLine/endLine', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'read_file', { path: 'src/a.js', start_line: 3, end_line: 9 });
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).path, 'src/a.js');
  const call = calls.find((entry) => entry.name === 'readFile');
  assert.deepEqual(call.args, { path: 'src/a.js', startLine: 3, endLine: 9 });
});

test('read_file without path is a -32602 protocol error', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'tools/call', { name: 'read_file', arguments: {} });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /"path"/);
});

test('read_file with a reversed line range is -32602', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'tools/call', { name: 'read_file', arguments: { path: 'a.js', start_line: 9, end_line: 3 } });
  assert.equal(response.error.code, -32602);
});

test('search_workspace happy path', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'search_workspace', { query: 'answer', regex: true, glob: '*.js', limit: 7 });
  assert.equal(result.isError, undefined);
  const call = calls.find((entry) => entry.name === 'search');
  assert.deepEqual(call.args, { query: 'answer', regex: true, caseSensitive: false, glob: '*.js', limit: 7 });
});

test('search_workspace without query is -32602', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'tools/call', { name: 'search_workspace', arguments: { limit: 5 } });
  assert.equal(response.error.code, -32602);
});

test('git_status happy path', async () => {
  const { mcp } = makeMcp();
  const result = await callTool(mcp, 'git_status', {});
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).branch, 'main');
});

test('git_diff happy path maps staged/path', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'git_diff', { staged: true, path: 'lib/a.js' });
  assert.equal(result.isError, undefined);
  assert.match(jsonOf(result).content, /diff --git/);
  assert.deepEqual(calls.find((entry) => entry.name === 'gitDiff').args, { staged: true, path: 'lib/a.js' });
});

test('test_status happy path', async () => {
  const { mcp } = makeMcp();
  const result = await callTool(mcp, 'test_status', {});
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).tests, '27 passed');
});

test('execution_summary happy path maps task_id and limit', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'execution_summary', { task_id: 'c2c_f81a', limit: 3 });
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).records[0].taskId, 'c2c_f81a');
  assert.deepEqual(calls.find((entry) => entry.name === 'summary').args, {
    task_id: 'c2c_f81a',
    taskId: 'c2c_f81a',
    limit: 3,
  });
});

test('execution_output list and read happy paths', async () => {
  const { mcp, calls } = makeMcp();
  const listed = await callTool(mcp, 'execution_output', { action: 'list' });
  assert.equal(listed.isError, undefined);
  assert.equal(jsonOf(listed).action, 'list');
  assert.equal(jsonOf(listed).items[0].id, 'out_9f21');
  assert.deepEqual(calls.find((entry) => entry.name === 'output').args, { action: 'list' });

  const read = await callTool(mcp, 'execution_output', { action: 'read', id: 'out_9f21', task_id: 'c2c_f81a', iteration: 2 });
  assert.equal(read.isError, undefined);
  assert.equal(jsonOf(read).text, 'tests passed');
  assert.deepEqual(calls.filter((entry) => entry.name === 'output').at(-1).args, {
    action: 'read',
    id: 'out_9f21',
    task_id: 'c2c_f81a',
    taskId: 'c2c_f81a',
    iteration: 2,
  });
});

test('execution_output rejects an unknown action and read without id', async () => {
  const { mcp } = makeMcp();
  const badAction = await rpc(mcp, 'tools/call', { name: 'execution_output', arguments: { action: 'delete' } });
  assert.equal(badAction.error.code, -32602);

  const missingId = await rpc(mcp, 'tools/call', { name: 'execution_output', arguments: { action: 'read' } });
  assert.equal(missingId.error.code, -32602);
  assert.match(missingId.error.message, /id/);
});

test('read_image returns an MCP image content block', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'read_image', { path: 'docs/shot.png' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.equal(block.type, 'image');
  assert.equal(block.data, PNG_BASE64);
  assert.equal(block.mimeType, 'image/png');
  assert.deepEqual(calls.find((entry) => entry.name === 'readImage').args, { path: 'docs/shot.png' });
});

test('read_image never returns SVG as an image block', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const { mcp } = makeMcp({
    workspace: {
      readImage: async (args) => ({
        path: args.path,
        mimeType: 'image/svg+xml',
        base64: Buffer.from(svg, 'utf8').toString('base64'),
        bytes: svg.length,
      }),
    },
  });
  const result = await callTool(mcp, 'read_image', { path: 'logo.svg' });
  assert.equal(result.isError, undefined);
  assert.ok(result.content.every((entry) => entry.type !== 'image'), 'SVG must not be an image block');
  assert.match(textOf(result), /<svg/);
});

test('control_submit happy path validates and forwards the [C2C] message', async () => {
  const message = '[C2C]\nSTATE: PLAN\nTASK_ID: c2c_f81a\nITERATION: 1\n\nACTIONS:\n1. Add dark mode.';
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'control_submit', { message });
  assert.equal(result.isError, undefined);
  assert.equal(jsonOf(result).ok, true);
  assert.equal(calls.find((entry) => entry.name === 'submit').args, message);
});

test('control_submit enforces the [C2C] marker, known states and the 16 KiB cap', async () => {
  const { mcp, calls } = makeMcp();
  const noMarker = await rpc(mcp, 'tools/call', { name: 'control_submit', arguments: { message: 'hello' } });
  assert.equal(noMarker.error.code, -32602);
  assert.match(noMarker.error.message, /\[C2C\]/);

  const badState = await rpc(mcp, 'tools/call', { name: 'control_submit', arguments: { message: '[C2C]\nSTATE: PARTY\n' } });
  assert.equal(badState.error.code, -32602);
  assert.match(badState.error.message, /PARTY/);

  // A real multi-thread plan is a few kilobytes; the old 1 KiB cap rejected it.
  const realistic = `[C2C]\nSTATE: PLAN\nTASK_ID: c2c_abcd\nITERATION: 0\n\nGOAL:\nx\n\nACTIONS:\n${'1. do a thing with a file path\n'.repeat(150)}\nTESTS:\ny\n\nSUCCESS_CRITERIA:\nz`;
  const accepted = await callTool(mcp, 'control_submit', { message: realistic });
  assert.equal(accepted.isError, undefined, 'a multi-KB plan must be accepted');
  assert.equal(calls.filter((entry) => entry.name === 'submit').length, 1);

  const tooBig = `[C2C]\nSTATE: PLAN\n\n${'x'.repeat(20 * 1024)}`;
  const oversized = await rpc(mcp, 'tools/call', { name: 'control_submit', arguments: { message: tooBig } });
  assert.equal(oversized.error.code, -32602);
  assert.match(oversized.error.message, /16384/);

  assert.equal(calls.filter((entry) => entry.name === 'submit').length, 1, 'the oversized message must not reach the control plane');
});

test('control_submit accepts a lower-case marker', async () => {
  const { mcp } = makeMcp();
  const result = await callTool(mcp, 'control_submit', { message: '[c2c]\nstate: DONE\nTASK_ID: c2c_f81a\n' });
  assert.equal(result.isError, undefined);
});

test('control_inbox defaults to non-destructive reads and honours consume', async () => {
  const { mcp, calls } = makeMcp();
  const pending = await callTool(mcp, 'control_inbox', {});
  assert.equal(pending.isError, undefined);
  assert.equal(jsonOf(pending).messages.length, 1);
  assert.deepEqual(calls.find((entry) => entry.name === 'inbox').args, { consume: false });

  const consumed = await callTool(mcp, 'control_inbox', { consume: true });
  assert.equal(jsonOf(consumed).consumed, true);
  assert.deepEqual(calls.filter((entry) => entry.name === 'inbox').at(-1).args, { consume: true });
});

test('every one of the 12 tools runs to completion against fakes', async () => {
  const { mcp } = makeMcp();
  const argumentsByTool = {
    workspace_info: {},
    list_directory: {},
    read_file: { path: 'a.js' },
    search_workspace: { query: 'answer' },
    git_status: {},
    git_diff: {},
    test_status: {},
    execution_summary: {},
    execution_output: { action: 'list' },
    read_image: { path: 'a.png' },
    control_submit: { message: '[C2C]\nSTATE: PLAN\n' },
    control_inbox: {},
  };
  for (const name of EXPECTED_TOOLS) {
    const result = await callTool(mcp, name, argumentsByTool[name]);
    assert.ok(result.content, `${name} must return a content array`);
    assert.notEqual(result.isError, true, `${name} must succeed against the fakes`);
  }
});

/* ---------------------------------------------------------- error handling --- */

test('unknown tool is a -32602 protocol error', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'tools/call', { name: 'delete_everything', arguments: {} });
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /delete_everything/);
  assert.match(response.error.message, /tools\/list/);
});

test('missing tool name and non-object arguments are -32602', async () => {
  const { mcp } = makeMcp();
  const noName = await rpc(mcp, 'tools/call', { arguments: {} });
  assert.equal(noName.error.code, -32602);

  const badArgs = await rpc(mcp, 'tools/call', { name: 'read_file', arguments: ['path'] });
  assert.equal(badArgs.error.code, -32602);
});

test('a dependency that throws becomes isError:true with the message and no stack', async () => {
  const failure = new Error('W_P_DENIED: cannot read that file');
  failure.code = 'W_P_DENIED';
  failure.stack = `${failure.stack}\n    at secretInternal (/srv/private.js:1:1)`;
  const { mcp } = makeMcp({ workspace: { readFile: async () => { throw failure; } } });
  const result = await callTool(mcp, 'read_file', { path: 'nope.txt' });
  assert.equal(result.isError, true);
  const text = textOf(result);
  assert.match(text, /W_P_DENIED: cannot read that file/);
  assert.match(text, /W_P_DENIED/);
  assert.ok(!/Error:/.test(text), `stack header leaked: ${text}`);
  assert.ok(!/\n\s+at\s+/.test(text), `stack frames leaked: ${text}`);
  assert.ok(!text.includes('secretInternal'), 'internal file path leaked');
  assert.ok(!text.includes('/srv/private.js'), 'internal file path leaked');
});

test('a dependency that throws synchronously never rejects handle()', async () => {
  const { mcp } = makeMcp({
    workspace: {
      gitStatus: () => {
        throw new Error('sync boom');
      },
    },
  });
  const response = await rpc(mcp, 'tools/call', { name: 'git_status', arguments: {} });
  assert.equal(response.result.isError, true);
  assert.match(textOf(response.result), /sync boom/);
});

test('a missing dependency method is reported as a tool error, not a crash', async () => {
  const { mcp } = makeMcp({ execution: undefined });
  const response = await rpc(mcp, 'tools/call', { name: 'test_status', arguments: {} });
  assert.equal(response.result.isError, true);
  assert.match(textOf(response.result), /testStatus/);
});

test('unknown method is -32601 and notifications resolve to undefined', async () => {
  const { mcp } = makeMcp();
  const unknown = await rpc(mcp, 'tools/subscribe', {});
  assert.equal(unknown.error.code, -32601);
  assert.match(unknown.error.message, /tools\/subscribe/);

  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), undefined);
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ping' } }), undefined);
});

test('invalid JSON-RPC envelopes become -32600 and never reject', async () => {
  const { mcp } = makeMcp();
  for (const message of [null, 42, 'hello', [], [{ method: 'ping' }]]) {
    const response = await mcp.handle(Array.isArray(message) ? message : message);
    if (Array.isArray(message)) {
      assert.ok(Array.isArray(response) || response === undefined);
    } else {
      assert.equal(response.error.code, -32600);
      assert.equal(response.id, null);
    }
  }
  const noMethod = await mcp.handle({ jsonrpc: '2.0', id: 7 });
  assert.equal(noMethod.error.code, -32600);
  assert.equal(noMethod.id, 7);
});

test('handle() never rejects, even when reading the message throws', async () => {
  const { mcp } = makeMcp();
  const hostile = { jsonrpc: '2.0', id: 9 };
  Object.defineProperty(hostile, 'params', {
    get() {
      throw new Error('hostile getter');
    },
    enumerable: true,
  });
  const response = await mcp.handle(hostile);
  assert.equal(response.error.code, -32603);
  assert.equal(response.id, 9, 'a readable id must still be echoed');
  assert.doesNotMatch(response.error.message, /hostile getter/);
});

test('a dependency that returns a non-serializable value still produces a tool result', async () => {
  const circular = { name: 'loop' };
  circular.self = circular;
  const { mcp } = makeMcp({ workspace: { info: async () => circular } });
  const result = await callTool(mcp, 'workspace_info', {});
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /UNSERIALIZABLE_RESULT/);
});

test('huge tool output is capped by limits.toolTextBytes', async () => {
  const { mcp } = makeMcp({ workspace: { gitDiff: async () => ({ available: true, content: 'x'.repeat(50000) }) } }, { limits: { toolTextBytes: 4096 } });
  const result = await callTool(mcp, 'git_diff', {});
  const text = textOf(result);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 4096 + 128, 'text block must respect the byte cap');
  assert.match(text, /truncated/);
});

/* --------------------------------------------------------------- resources --- */

test('resources/list exposes exactly the two read-only JSON snapshots', async () => {
  const { mcp } = makeMcp();
  const response = await rpc(mcp, 'resources/list');
  const uris = response.result.resources.map((resource) => resource.uri);
  assert.deepEqual(uris, ['c2c://session/status', 'c2c://control/pending']);
  for (const resource of response.result.resources) {
    assert.equal(resource.mimeType, 'application/json');
    assert.ok(resource.description.length > 0);
  }
});

test('resources/read returns JSON contents for both URIs', async () => {
  const { mcp, calls } = makeMcp();
  const status = await rpc(mcp, 'resources/read', { uri: 'c2c://session/status' });
  const statusContent = status.result.contents[0];
  assert.equal(statusContent.uri, 'c2c://session/status');
  assert.equal(statusContent.mimeType, 'application/json');
  assert.equal(JSON.parse(statusContent.text).state, 'EXECUTED');
  assert.equal(calls.find((entry) => entry.name === 'status').name, 'status');

  const pending = await rpc(mcp, 'resources/read', { uri: 'c2c://control/pending' });
  const pendingContent = pending.result.contents[0];
  assert.equal(pendingContent.uri, 'c2c://control/pending');
  assert.equal(JSON.parse(pendingContent.text).messages.length, 1);
  assert.deepEqual(calls.filter((entry) => entry.name === 'inbox').at(-1).args, { consume: false });
});

test('resources/read reports a missing session snapshot without failing', async () => {
  const { mcp } = makeMcp({ execution: { status: undefined } });
  const response = await rpc(mcp, 'resources/read', { uri: 'c2c://session/status' });
  const payload = JSON.parse(response.result.contents[0].text);
  assert.equal(payload.available, false);
  assert.equal(payload.reason, 'UNSUPPORTED');
});

test('resources/read unknown URI and missing uri are -32602', async () => {
  const { mcp } = makeMcp();
  const unknown = await rpc(mcp, 'resources/read', { uri: 'c2c://nope' });
  assert.equal(unknown.error.code, -32602);
  const missing = await rpc(mcp, 'resources/read', {});
  assert.equal(missing.error.code, -32602);
});

/* ----------------------------------------------------------------- batches --- */

test('batch requests keep per-message ids and drop notification-only batches', async () => {
  const { mcp } = makeMcp();
  const batch = await mcp.handle([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'a', method: 'ping' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  assert.ok(Array.isArray(batch));
  assert.equal(batch.length, 2);
  assert.deepEqual(batch.map((entry) => entry.id), ['a', 'b']);
  assert.equal(await mcp.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), undefined);
  assert.deepEqual(await mcp.handle([]), undefined);
});

/* ---------------------------------------------------------------- tolerance --- */

test('unknown and misspelled arguments are ignored, not rejected', async () => {
  const { mcp, calls } = makeMcp();
  const result = await callTool(mcp, 'list_directory', { path: 'src', lmit: 5, bogus: true, nested: { a: 1 } });
  assert.equal(result.isError, undefined);
  const call = calls.find((entry) => entry.name === 'listDirectory');
  assert.equal(call.args.path, 'src');
  assert.equal(call.args.limit, 200, 'a misspelled limit must not reach the dependency');
  assert.ok(!('bogus' in call.args));
});

test('createMcp works with no dependencies at all and still answers the protocol', async () => {
  const mcp = createMcp({ log: fakeLog() });
  const init = await rpc(mcp, 'initialize', {});
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await rpc(mcp, 'tools/list');
  assert.equal(list.result.tools.length, 12);
  const failed = await rpc(mcp, 'tools/call', { name: 'workspace_info', arguments: {} });
  assert.equal(failed.result.isError, true);
  assert.match(textOf(failed.result), /workspace/);
});

test('createMcp() has no top-level side effects or network use', async () => {
  const source = await readFile(MCP_FILE, 'utf8');
  assert.ok(!/^\s*(await|fetch\()/m.test(source), 'no top-level await/fetch');
  assert.ok(!source.includes('node:http') && !source.includes('node:fs'), 'mcp.js must stay transport and IO free');
});
