// The host plugin entry point.
//
// One row inserts this bundle. It provides:
//   * a read-only MCP bridge on the DSH web server (OAuth 2.1 protected),
//   * a control channel for [C2C] messages between ChatGPT and this agent,
//   * 8 DSH tools so the local agent runs the C2C loop without leaving the harness,
//   * a system-prompt section describing the protocol to the agent,
//   * slash commands for setup / status / disconnect,
//   * a settings panel in the Web UI (see ./client).
//
// Nothing is registered at import time: `apply()` is the only entry point.

import { createMcp } from './mcp.js';
import { BridgeHttp } from './http.js';
import { ControlHub } from './control.js';
import { ExecutionJournal } from './execution.js';
import { PairingManager } from './pairing.js';
import { AuthServer } from './oauth.js';
import { TunnelManager } from './tunnel.js';
import { Workspace } from './workspace.js';
import { StateStore, stateRoot } from './state.js';
import {
  buildBootPrompt,
  buildControl,
  buildExecuted,
  buildHandoff,
  buildInit,
  buildProjectInstructions,
  buildVerifyPrompt,
  createTaskId,
  parseControlMessage,
} from './c2c.js';
import { createLogger, truncate } from './util.js';
import { defineTool } from './tool-spec.js';
import { LicenseManager, reasonText } from './license.js';

export const name = 'dshWithChatgpt';
// The bridge self-hosts its HTTP listener (node:http), so no shared web server
// service is needed — that service does not exist in the desktop profile anyway.
export const inject = ['tools', 'systemPrompt', 'commands'];

const DEFAULT_PREFIX = '/dsh-with-chatgpt';
const DEFAULT_PORT = 3780;
const CONFIG_VERSION = 1;

/**
 * Declarative defaults. The patch row may override any of them; a validated copy
 * lands in `config` without extra dependencies (no schemastery import here, this
 * bundle is dependency-free on purpose).
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  prefix: DEFAULT_PREFIX,
  port: DEFAULT_PORT,
  host: '127.0.0.1',
  workspace: '',
  connectorName: '',
  maxIterations: 12,
  autoStartTunnel: false,
  tunnel: 'quick',
  cloudflaredPath: '',
  // Public origin for externally-managed tunnels (e.g. a Windows service or a
  // scheduled task runs cloudflared with its own config): when set, the bridge
  // reports this URL instead of spawning its own child and mcpUrl uses it.
  publicOrigin: '',
  // Named-tunnel options for the bridge-managed child: a token (remote-managed
  // ingress) or a hostname + local config file (credentials from disk).
  tunnelToken: '',
  tunnelHostname: '',
  tunnelName: '',
  tunnelConfigPath: '',
  debug: false,
  limits: {
    maxFileBytes: 128 * 1024,
    maxDiffBytes: 96 * 1024,
    maxOutputBytes: 64 * 1024,
    maxOutputLines: 600,
    maxImageBytes: 4 * 1024 * 1024,
    // [C2C] control-message ceiling. Mirrors MAX_CONTROL_BYTES in c2c.js so the
    // MCP pre-check and the control plane agree; override here to tune it.
    controlMessageBytes: 16 * 1024,
  },
});

/** Accept both `tunnel: 'quick'` and the older `tunnel: {mode, provider}` shape. */
function normalizeTunnel(value) {
  if (typeof value === 'string') return value.trim().toLowerCase() === 'named' ? 'named' : 'quick';
  if (value && typeof value === 'object' && typeof value.mode === 'string') {
    return value.mode.trim().toLowerCase() === 'named' ? 'named' : 'quick';
  }
  return 'quick';
}

/** Coerce the row config into the exact shape the modules expect. */
export function normalizeConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input ?? {}) };
  const limits = { ...DEFAULTS.limits, ...((input ?? {}).limits ?? {}) };
  const maxIterations = Number(merged.maxIterations);
  return {
    version: CONFIG_VERSION,
    enabled: merged.enabled !== false,
    prefix: normalizePrefix(merged.prefix),
    port: positive(merged.port, DEFAULT_PORT),
    host: String(merged.host ?? '127.0.0.1').trim() || '127.0.0.1',
    workspace: String(merged.workspace ?? '').trim(),
    connectorName: String(merged.connectorName ?? '').trim(),
    maxIterations: Number.isFinite(maxIterations) && maxIterations > 0 ? Math.trunc(maxIterations) : 12,
    autoStartTunnel: merged.autoStartTunnel === true,
    tunnel: normalizeTunnel(merged.tunnel),
    cloudflaredPath: String(merged.cloudflaredPath ?? '').trim(),
    publicOrigin: normalizeOrigin(merged.publicOrigin),
    tunnelToken: String(merged.tunnelToken ?? '').trim(),
    tunnelHostname: normalizeHostnameField(merged.tunnelHostname),
    tunnelName: String(merged.tunnelName ?? '').trim(),
    tunnelConfigPath: String(merged.tunnelConfigPath ?? '').trim(),
    debug: merged.debug === true,
    limits: {
      maxFileBytes: positive(limits.maxFileBytes, DEFAULTS.limits.maxFileBytes),
      maxDiffBytes: positive(limits.maxDiffBytes, DEFAULTS.limits.maxDiffBytes),
      maxOutputBytes: positive(limits.maxOutputBytes, DEFAULTS.limits.maxOutputBytes),
      maxOutputLines: positive(limits.maxOutputLines, DEFAULTS.limits.maxOutputLines),
      maxImageBytes: positive(limits.maxImageBytes, DEFAULTS.limits.maxImageBytes),
      controlMessageBytes: positive(limits.controlMessageBytes, DEFAULTS.limits.controlMessageBytes),
    },
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function normalizePrefix(value) {
  const raw = String(value ?? '').trim() || DEFAULT_PREFIX;
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, '') || DEFAULT_PREFIX;
}

/** Origin without path or trailing slash; empty stays empty. */
function normalizeOrigin(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

/** Bare hostname from a URL or hostname string; empty stays empty. */
function normalizeHostnameField(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** The live bridge: owns every long-lived object and the wiring between them. */
class Bridge {
  constructor({ ctx, config }) {
    this.ctx = ctx;
    this.config = config;
    this.log = createLogger('dsh-with-chatgpt', config.debug);
    this.store = new StateStore();
    this.workspace = null;
    this.pairing = null;
    this.auth = null;
    this.tunnel = null;
    this.control = null;
    this.journal = null;
    this.mcp = null;
    this.http = null;
    this.license = null;
    this.disposers = [];
    // Overwritten in start() once the self-hosted listener is up; the tunnel
    // manager receives this origin so its public URL forwards to the right port.
    this.localOrigin = `http://127.0.0.1:${DEFAULT_PORT}`;
    this.connectorName = config.connectorName || 'DSH with ChatGPT';
  }

  get prefix() {
    return this.config.prefix;
  }

  /** The connector URL a user pastes into ChatGPT. */
  get mcpUrl() {
    // An externally-managed public origin (fixed domain) wins over the local
    // listener and over a bridge-managed tunnel: it is the stable address.
    const base = this.config.publicOrigin !== ''
      ? this.config.publicOrigin
      : (this.tunnel?.status?.().url || this.localOrigin);
    return `${base}${this.prefix}/mcp`;
  }

  /** Public https origin the connector should use, or null when loopback-only. */
  get publicOrigin() {
    if (this.config.publicOrigin !== '') return this.config.publicOrigin;
    return this.tunnel?.status?.().url ?? null;
  }

  async start() {
    await this.store.init();
    // License gate #1 of four: the manager re-verifies the stored activation on
    // every start (hash allowlist, machine binding, integrity tag) so an edited
    // state file cannot stay activated across a restart.
    this.license = new LicenseManager({ store: this.store, log: this.log });
    await this.license.init();
    if (!this.license.active) {
      // Deliberately still bind the loopback listener: the settings panel posts the
      // key to it, so refusing to listen would make activation impossible. Nothing
      // else is created — no workspace, no MCP dispatcher, no tunnel — which is why
      // the remaining three gates have nothing to leak.
      this.log.warn?.(`license inactive (${reasonText(this.license.reason)}) — open Settings → ChatGPT to activate`);
      this.http = new BridgeHttp({
        store: this.store,
        auth: null,
        pairing: null,
        tunnel: null,
        control: null,
        journal: null,
        workspace: null,
        mcp: null,
        config: this.config,
        log: this.log,
        bridge: this,
        license: this.license,
      });
      this.localOrigin = await this.http.start();
      return this;
    }
    await this.startBridge();
    return this;
  }

  /** Everything that only exists once the license is active. */
  async startBridge() {
    const workspaceRoot = await this.resolveWorkspaceRoot();
    this.workspace = await Workspace.create({
      root: workspaceRoot,
      limits: {
        allowSensitive: false,
        maxFileBytes: this.config.limits.maxFileBytes,
        maxDiffBytes: this.config.limits.maxDiffBytes,
        maxImageBytes: this.config.limits.maxImageBytes,
      },
    });
    // ChatGPT connector names are per-account and must not collide between
    // workspaces, so an unnamed connector gets the workspace folded in. A user
    // who sets `connectorName` keeps full control over the label.
    if (this.config.connectorName === '') {
      this.connectorName = `DSH with ChatGPT (${this.workspace.name})`;
    }
    this.pairing = new PairingManager({ store: this.store, log: this.log });
    this.auth = new AuthServer({
      store: this.store,
      config: {
        version: this.config.version,
        prefix: this.prefix,
        workspaceName: this.workspace.name,
        connectorName: this.connectorName,
      },
      log: this.log,
    });
    this.control = new ControlHub({ store: this.store, log: this.log });
    await this.control.init();
    this.journal = new ExecutionJournal({ store: this.store, limits: this.config.limits, log: this.log });
    this.tunnel = new TunnelManager({
      store: this.store,
      config: {
        cloudflaredPath: this.config.cloudflaredPath,
        mode: this.config.tunnel,
        cwd: this.workspace.root,
        token: this.config.tunnelToken,
        named: this.config.tunnelHostname,
        tunnelName: this.config.tunnelName,
        configPath: this.config.tunnelConfigPath,
      },
      log: this.log,
      localOrigin: this.localOrigin,
      onChange: (status) => this.log.debug?.('tunnel', status?.state, status?.url ?? ''),
    });
    this.mcp = createMcp({
      workspace: this.workspace,
      execution: this.enhancedExecution(),
      control: this.enhancedControl(),
      limits: this.config.limits,
      log: this.log,
    });
    const deps = {
      auth: this.auth,
      pairing: this.pairing,
      tunnel: this.tunnel,
      control: this.control,
      journal: this.journal,
      workspace: this.workspace,
      mcp: this.mcp,
    };
    if (this.http !== null) {
      // Activation path: the locked listener is already bound and serving the
      // settings panel, so the bridge upgrades that same instance in place. A new
      // listener would hit EADDRINUSE and leave the dependency-less one answering.
      this.http.attach(deps);
    } else {
      this.http = new BridgeHttp({
        store: this.store,
        ...deps,
        config: this.config,
        log: this.log,
        bridge: this,
        license: this.license,
      });
      // The bridge owns its listener: without it nothing (tunnel target, panel,
      // ChatGPT connector) can reach the endpoints below `config.prefix`.
      this.localOrigin = await this.http.start();
    }
    this.tunnel.localOrigin = this.localOrigin;
    return this;
  }

  /** Wrap the journal so the MCP resource can read session status from it. */
  enhancedExecution() {
    const journal = this.journal;
    const store = this.store;
    return {
      testStatus: () => journal.testStatus(),
      summary: (args) => journal.summary(args),
      output: (args) => journal.output(args),
      status: () => sessionSnapshot(store),
      session: () => sessionSnapshot(store),
    };
  }

  enhancedControl() {
    const control = this.control;
    return {
      submit: (message) => control.submit({ message }),
      inbox: (args) => control.inbox(args),
      snapshot: () => control.snapshot(),
    };
  }

  async resolveWorkspaceRoot() {
    if (this.config.workspace !== '') return this.config.workspace;
    try {
      const root = this.ctx.workingDirectory?.defaultDirectory;
      if (typeof root === 'string' && root.trim() !== '') return root;
    } catch { /* fall through */ }
    return process.cwd();
  }

  /**
   * Register every extension this plugin owns. The HTTP surface is already live
   * (BridgeHttp.start() in start()); the well-known OAuth metadata is rendered at
   * the bridge origin root by BridgeHttp.handle() itself.
   */
  mount() {
    this.disposers.push(this.registerLicenseTool());
    // The license command is the unlicensed user's only handle: it prints the
    // machine code they must send the seller, so it registers before the gate.
    this.disposers.push(this.registerLicenseCommand());
    // Gates #2 and #3: with an inactive license the c2c_* tools are not registered
    // at all and the system prompt section is never installed, so an agent has no
    // loop to drive and no instruction telling it one exists. The license tool is
    // the only thing left, and it can do nothing but report or accept a key.
    if (!this.licensed()) {
      this.log.info?.('license inactive: ChatGPT tools and prompt stay off until activated');
      return this;
    }
    this.disposers.push(this.registerTools());
    this.disposers.push(this.registerPrompt());
    this.disposers.push(this.registerCommands());
    if (this.config.autoStartTunnel && this.config.publicOrigin === '') {
      // Opt-in: bring the public tunnel up with the bridge so the connector URL is
      // stable for the length of the session. Off by default — a tunnel is a
      // network-visible action the user should ask for. Skipped when a fixed
      // public origin is configured: an external supervisor (Windows service,
      // scheduled task) already owns the tunnel, and a second child would race.
      void this.connect().catch((error) => {
        this.log.warn?.(`autoStartTunnel failed: ${error?.message ?? error}`);
      });
    } else if (this.config.autoStartTunnel && this.config.publicOrigin !== '') {
      this.log.info?.(`tunnel is externally managed; connector URL ${this.mcpUrl}`);
    }
    return this;
  }

  /** @returns {boolean} true when the license currently opens every gate. */
  licensed() {
    return this.license?.active === true;
  }

  /**
   * Called after a successful activation so the rest of the plugin comes alive
   * without a DSH restart: the listener already exists, only the extensions and
   * the bridge objects were missing.
   */
  async resumeAfterActivation() {
    if (this.workspace !== null) return this;
    await this.startBridge();
    this.mount();
    this.log.info?.('license activated: bridge and tools are live');
    return this;
  }

  /**
   * The one tool that exists without a license. It can report status and accept a
   * key; it cannot start a loop, read the workspace or touch the bridge. Activation
   * through it is equivalent to the settings page (same LicenseManager).
   */
  registerLicenseTool() {
    const disposers = [];
    const register = (definition) => {
      try {
        disposers.push(this.ctx.tools.register(definition));
      } catch (error) {
        this.log.warn?.(`cannot register tool "${definition.name}": ${error?.message ?? error}`);
      }
    };
    register(defineTool({
      name: 'c2c_license',
      description: 'Report or activate the dsh-with-chatgpt license. Without an active license every other c2c_* tool is unavailable and the ChatGPT prompt is not installed. Actions: "status" (default) reports the current state; "activate" takes a key from the user and enables the plugin; "deactivate" removes the license from this machine.',
      parameters: {
        action: { type: 'string', enum: ['status', 'activate', 'deactivate'], description: 'What to do (default "status").' },
        key: { type: 'string', description: 'The license key, only for action "activate". Never echo it back.' },
      },
      output: {
        schema: {
          ok: { type: 'boolean', description: 'Whether the requested action succeeded' },
          status: { type: 'object', additionalProperties: true, description: 'License status' },
          message: { type: 'string', description: 'One-line result for the user' },
        },
        render: (args, value) => [{
          type: 'text',
          text: `${value.ok ? '' : 'Failed: '}${value.message}`,
        }],
      },
      execute: async (args) => {
        const action = String(args.action ?? 'status').trim().toLowerCase();
        if (action === 'activate') {
          const result = await this.license.activate(args.key);
          if (!result.ok) {
            return { ok: false, status: result.status, message: `${reasonText(result.reason)} (${result.reason})` };
          }
          await this.resumeAfterActivation();
          return { ok: true, status: result.status, message: `License activated (${result.status.edition}). The ChatGPT bridge is live — run c2c_setup to get the connector URL and pairing code.` };
        }
        if (action === 'deactivate') {
          const result = await this.license.deactivate();
          return { ok: true, status: result.status, message: 'License removed from this machine. A DSH restart releases the bridge.' };
        }
        const status = this.license.status();
        return {
          ok: status.active,
          status,
          message: status.active
            ? `Active (${status.edition})${status.customer ? ` for ${status.customer}` : ''}, machine ${status.machineCode}`
              + `${Number(status.maxSeats) > 0 ? `, ${status.seats}/${status.maxSeats} seat(s)` : ''}.`
            : `${reasonText(status.reason)} (${status.reason}). This machine's code is ${status.machineCode}`
              + ' — send it to the seller to get a key.',
        };
      },
    }));
    return () => {
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* ignore */ }
      }
    };
  }

  /** Every agent-facing tool this plugin adds. */
  registerTools() {
    const disposers = [];
    const register = (definition) => {
      try {
        disposers.push(this.ctx.tools.register(definition));
      } catch (error) {
        this.log.warn?.(`cannot register tool "${definition.name}": ${error?.message ?? error}`);
      }
    };

    register(defineTool({
      name: 'c2c_start',
      description: 'Start a ChatGPT planning loop (C2C). Mints a task id, records the INIT control message, and returns the message to send to ChatGPT plus the connector URL. Use this when the user says "使用 ChatGPT 规划" / "用 ChatGPT 规划" / "让 ChatGPT 帮我规划".',
      parameters: {
        goal: { type: 'string', required: true, description: 'The user goal in one paragraph, as the user stated it.' },
      },
      output: {
        schema: {
          taskId: { type: 'string', description: 'C2C task id' },
          iteration: { type: 'number', description: 'Iteration number' },
          initMessage: { type: 'string', description: 'The [C2C] INIT control message to send to ChatGPT' },
          mcpUrl: { type: 'string', description: 'Connector URL for ChatGPT' },
          bootPrompt: { type: 'string', description: 'One-time boot prompt for a new ChatGPT conversation' },
        },
        render: (args, value) => [{
          type: 'text',
          text: `C2C task ${value.taskId} started.\nConnector URL: ${value.mcpUrl}\n\nSend this to ChatGPT:\n\n${value.bootPrompt}\n\n${value.initMessage}`,
        }],
      },
      execute: async (args, exec) => {
        const goal = String(args.goal ?? '').trim();
        if (goal === '') throw new Error('goal must not be empty');
        const existing = this.store.session;
        const taskId = existing?.taskId || createTaskId();
        const iteration = 0;
        const message = buildInit({ taskId, iteration, goal });
        await this.control.recordOutbound({ message, kind: 'init' });
        await this.store.updateSession({
          taskId,
          iteration,
          state: 'INIT',
          protocolState: 'INIT',
          waitingFor: 'GPT_PLAN',
          goal: truncate(goal, 1000),
          nextStep: 'wait for PLAN',
        });
        this.rememberAgent(exec, taskId);
        return {
          taskId,
          iteration,
          initMessage: message,
          mcpUrl: this.mcpUrl,
          bootPrompt: this.bootPromptSync(),
        };
      },
    }));

    register(defineTool({
      name: 'c2c_inbox',
      description: 'Read the [C2C] control messages ChatGPT sent back (PLAN / DONE / BLOCKED / HANDOFF / ERROR) and advance the local checkpoint. Call this after telling the user to wait for ChatGPT, or whenever you need to know whether a plan arrived. Set consume=true to acknowledge (default true).',
      parameters: {
        consume: { type: 'boolean', description: 'Acknowledge the returned messages (default true).' },
        state: { type: 'string', description: 'Only return messages in this state, e.g. "PLAN".' },
      },
      output: {
        schema: {
          pending: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Pending control messages' },
          consumed: { type: 'number', description: 'How many were acknowledged' },
          checkpoint: { type: 'object', additionalProperties: true, description: 'Updated local checkpoint' },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.pending.length === 0
            ? 'No pending [C2C] control message from ChatGPT.'
            : value.pending.map((row) => `--- ${row.state} (iteration ${row.iteration}) ---\n${row.text}`).join('\n\n'),
        }],
      },
      execute: async (args) => {
        const consume = args.consume !== false;
        const result = await this.control.inbox({ consume, state: args.state, limit: 10 });
        let checkpoint = this.store.session;
        for (const row of result.pending) {
          const next = advanceCheckpoint(checkpoint, row);
          if (next) {
            await this.store.updateSession(next);
            checkpoint = this.store.session;
          }
        }
        const budget = this.budgetWarning(checkpoint);
        if (budget !== null) await this.store.updateSession({ knownIssues: budget });
        return { pending: result.pending, consumed: result.consumed, checkpoint: publicSession(this.store.session) };
      },
    }));

    register(defineTool({
      name: 'c2c_record',
      description: 'Record what one iteration actually did so ChatGPT can review it through MCP: changed files, test result, exit status, and optionally the sanitized output of the test/build/lint command. Never pass file bodies, .env contents or unrelated dumps.',
      parameters: {
        changed_files: { type: 'string', description: 'Comma-separated workspace-relative paths that changed.' },
        tests: { type: 'string', description: 'Short test result, e.g. "27 passed".' },
        exit_status: { type: 'string', enum: ['ok', 'fail', 'partial', 'skipped'], description: 'Overall outcome of this iteration.' },
        command: { type: 'string', description: 'The test/build/lint command that ran, e.g. "pnpm test".' },
        output: { type: 'string', description: 'Optional stdout/stderr of that command. It is sanitized locally and may be withheld from ChatGPT.' },
        summary: { type: 'string', description: 'One or two sentences describing the change.' },
      },
      output: {
        schema: {
          record: { type: 'object', additionalProperties: true, description: 'The stored execution record' },
        },
        render: (args, value) => [{
          type: 'text',
          text: `Recorded iteration ${value.record.iteration}: ${value.record.changedFileCount} file(s), tests ${value.record.tests}, status ${value.record.exitStatus}.`,
        }],
      },
      execute: async (args) => {
        // A round keeps one iteration number from INIT through EXECUTED, so the
        // number ChatGPT sees in a PLAN always matches the EXECUTED it reviews.
        // The increment happens when ChatGPT opens the NEXT round with a new PLAN.
        const session = this.store.session;
        const iteration = Number(session.iteration) || 0;
        const record = await this.journal.record({
          taskId: session.taskId ?? 'c2c_unknown',
          iteration,
          changedFiles: args.changed_files,
          tests: args.tests,
          exitStatus: args.exit_status,
          command: args.command,
          output: args.output,
          summary: args.summary,
        });
        const budget = this.budgetWarning(iteration);
        await this.store.updateSession({
          iteration,
          protocolState: 'EXECUTED_LOCAL',
          waitingFor: null,
          nextStep: 'send EXECUTED',
          ...(budget === null ? {} : { knownIssues: budget }),
        });
        return { record };
      },
    }));

    register(defineTool({
      name: 'c2c_executed',
      description: 'Build the [C2C] EXECUTED control message for the current iteration and return it to send to ChatGPT. Call c2c_record first. The message carries a changed-file count and the test line only — never a diff or a log body.',
      parameters: {
        result: { type: 'string', description: 'One-line result, e.g. "Execution finished".' },
      },
      output: {
        schema: {
          message: { type: 'string', description: 'The [C2C] EXECUTED message' },
          iteration: { type: 'number', description: 'Iteration number' },
          taskId: { type: 'string', description: 'Task id' },
        },
        render: (args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const session = this.store.session;
        const taskId = session.taskId ?? 'c2c_unknown';
        const iteration = Number(session.iteration) || 0;
        const { latest } = await this.journal.summary({ taskId, limit: 50 });
        const message = buildExecuted({
          taskId,
          iteration,
          result: args.result ?? latest?.summary ?? 'Execution finished.',
          changedFiles: latest?.changedFileCount ?? 0,
          tests: latest?.tests ?? 'not run',
        });
        await this.control.recordOutbound({ message, kind: 'executed' });
        await this.store.updateSession({ protocolState: 'EXECUTED_SENT', waitingFor: 'GPT_REVIEW', nextStep: 'wait for PLAN or DONE' });
        return { message, iteration, taskId };
      },
    }));

    register(defineTool({
      name: 'c2c_handoff',
      description: 'Send a [C2C] HANDOFF control message when the ChatGPT conversation was lost: goal, progress, current state, known issues and the next expected step. Never include logs or diffs.',
      parameters: {
        progress: { type: 'string', description: 'What has been done so far.' },
        current_state: { type: 'string', description: 'Current local checkpoint state.' },
        known_issues: { type: 'string', description: 'Known problems or blockers.' },
        next_expected_step: { type: 'string', description: 'What ChatGPT should do next.' },
      },
      output: {
        schema: { message: { type: 'string', description: 'The [C2C] HANDOFF message' } },
        render: (args, value) => [{ type: 'text', text: value.message }],
      },
      execute: async (args) => {
        const session = this.store.session;
        const taskId = session.taskId ?? 'c2c_unknown';
        const iteration = Number(session.iteration) || 0;
        const message = buildHandoff({
          taskId,
          iteration,
          originalGoal: session.goal ?? '(goal not recorded)',
          progress: args.progress ?? '(not recorded)',
          currentState: args.current_state ?? session.protocolState ?? session.state ?? 'INIT',
          knownIssues: args.known_issues ?? '(none recorded)',
          nextExpectedStep: args.next_expected_step ?? 'Continue from the last PLAN.',
        });
        await this.control.recordOutbound({ message, kind: 'handoff' });
        return { message };
      },
    }));

    register(defineTool({
      name: 'c2c_session',
      description: 'Show the local C2C checkpoint: task id, iteration, protocol state, what we are waiting for, goal and next step. Pass action="set" to update the state, action="clear" to clear the checkpoint (after DONE).',
      parameters: {
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'What to do. Default "get".' },
        state: { type: 'string', description: 'New protocol state for action="set", e.g. "DONE".' },
        protocol_state: { type: 'string', description: 'New local checkpoint for action="set".' },
        waiting_for: { type: 'string', description: 'What we are waiting for: GPT_PLAN, GPT_REVIEW, USER, none.' },
        next_step: { type: 'string', description: 'Short next step.' },
        goal: { type: 'string', description: 'Replace the recorded goal.' },
        known_issues: { type: 'string', description: 'Replace the recorded known issues.' },
      },
      output: {
        schema: { session: { type: 'object', additionalProperties: true, description: 'Current session state' } },
        render: (args, value) => [{
          type: 'text',
          text: JSON.stringify(value.session, null, 2),
        }],
      },
      execute: async (args) => {
        const action = args.action ?? 'get';
        if (action === 'clear') {
          await this.store.clearCheckpoint();
          return { session: publicSession(this.store.session) };
        }
        if (action === 'set') {
          const patch = {};
          for (const key of ['state', 'protocolState', 'waitingFor', 'nextStep', 'goal', 'knownIssues']) {
            const value = args[key];
            if (value !== undefined) patch[key] = value === '' ? null : String(value).slice(0, 2000);
          }
          if (args.protocol_state !== undefined) patch.protocolState = args.protocol_state;
          if (args.waiting_for !== undefined) patch.waitingFor = args.waiting_for;
          if (args.next_step !== undefined) patch.nextStep = args.next_step;
          if (args.known_issues !== undefined) patch.knownIssues = args.known_issues;
          await this.store.updateSession(patch);
        }
        return { session: publicSession(this.store.session) };
      },
    }));

    register(defineTool({
      name: 'c2c_setup',
      description: 'Prepare the ChatGPT connection and return the three things the user needs: the connector URL to add in ChatGPT, a fresh pairing code, and the Project instructions to paste into the ChatGPT Project settings. Use when the user asks to set up / connect ChatGPT.',
      parameters: {
        action: { type: 'string', enum: ['status', 'setup', 'pair', 'connect', 'disconnect'], description: 'status (default), setup (tunnel + pairing code in one step), pair (mint a pairing code), connect (start the public tunnel), disconnect (revoke access).' },
      },
      output: {
        schema: {
          ok: { type: 'boolean', description: 'Whether the action succeeded' },
          status: { type: 'object', additionalProperties: true, description: 'Current bridge status' },
          pairingCode: { type: 'string', description: 'Pairing code to type in the browser (XXXX-XXXX)' },
          mcpUrl: { type: 'string', description: 'Connector URL' },
          connectorName: { type: 'string', description: 'Connector name to use in ChatGPT' },
          projectInstructions: { type: 'string', description: 'Project instructions to paste' },
          bootPrompt: { type: 'string', description: 'Boot prompt for the first conversation' },
          verifyPrompt: { type: 'string', description: 'Message that proves the connector is bound to this workspace' },
        },
        render: (args, value) => [{
          type: 'text',
          text: [
            `Bridge: ${value.status?.bridge?.running ? 'running' : 'stopped'}`,
            `Connector name: ${value.connectorName}`,
            `Connector URL: ${value.mcpUrl}`,
            value.pairingCode ? `Pairing code: ${value.pairingCode}` : 'Pairing code: (none — run action="pair")',
            '',
            'Project instructions:',
            value.projectInstructions,
          ].join('\n'),
        }],
      },
      execute: async (args) => this.setupAction(args.action ?? 'status'),
    }));

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* already disposed */ }
      }
    };
  }

  async setupAction(action) {
    const info = await this.workspace.info();
    const projectInstructions = buildProjectInstructions({
      workspaceName: info.name,
      projectType: info.projectType,
      languages: info.languages ?? [],
      frameworks: info.frameworks ?? [],
      connectorName: this.connectorName,
    });
    const out = {
      ok: true,
      connectorName: this.connectorName,
      mcpUrl: this.mcpUrl,
      projectInstructions,
      bootPrompt: this.bootPromptSync(),
      verifyPrompt: buildVerifyPrompt(this.connectorName),
    };
    // `setup` is the one-shot path: bring the tunnel up first so the URL returned
    // to the user is the public one ChatGPT can actually reach, then mint the code.
    if (action === 'setup') {
      if (this.publicOrigin === null && !this.tunnel.status().running) await this.connect();
      const issued = await this.pairing.issue();
      out.pairingCode = issued.code;
      out.tunnel = this.tunnel.status();
      if (this.config.publicOrigin !== '') out.publicOrigin = this.config.publicOrigin;
    }
    if (action === 'pair') {
      const issued = await this.pairing.issue();
      out.pairingCode = issued.code;
    }
    if (action === 'connect') {
      const result = await this.connect();
      out.ok = result.ok;
      out.tunnel = result;
    }
    if (action === 'disconnect') {
      await this.disconnect();
      out.ok = true;
    }
    if (action === 'status') {
      out.pairingCode = this.pairing.status().code ?? '';
    }
    out.mcpUrl = this.mcpUrl;
    // The panel and the agent both need the machine code: it is what a buyer sends
    // the seller, and what identifies this seat of a two-machine licence.
    out.machineCode = this.license.status().machineCode;
    out.license = this.license.status();
    out.status = await this.http.stateSnapshot();
    return out;
  }

  /**
   * The six-line success checklist the user expects to see, mirroring upstream's
   * "Codex with ChatGPT / ✓ project detected / … / Ready." Every line is derived
   * from real state, never assumed.
   */
  checklist(result = {}) {
    const tunnel = this.tunnel?.status?.() ?? {};
    const clients = this.auth?.listClients?.() ?? [];
    const paired = clients.length > 0;
    const line = (ok, text) => `${ok ? '✓' : '✗'} ${text}`;
    const secureOk = this.publicOrigin !== null
      || (Boolean(tunnel.running) && typeof tunnel.url === 'string' && tunnel.url !== '');
    const secureText = this.config.publicOrigin !== ''
      ? `安全连接已建立（固定域名 ${this.config.publicOrigin.replace(/^https:\/\//, '')}）`
      : '安全连接已建立';
    return [
      'DSH with ChatGPT',
      line(Boolean(this.workspace?.root), `当前项目已识别（${this.workspace?.name ?? '未知'}）`),
      line(Boolean(this.http), 'Workspace Bridge 已启动'),
      line(secureOk, secureText),
      line(paired, paired ? 'ChatGPT 已连接' : 'ChatGPT 尚未连接'),
      line(Boolean(result.pairingCode), result.pairingCode ? '配对码已生成' : '配对码未生成'),
      paired ? 'Ready.' : '接下来：在 ChatGPT 里添加连接器并输入配对码。',
    ].join('\n');
  }

  async connect() {
    try {
      const started = await this.tunnel.start();
      return { ok: Boolean(started?.url), url: started?.url ?? null, error: started?.error ?? null };
    } catch (error) {
      this.log.warn?.(`tunnel start failed: ${error?.message ?? error}`);
      return { ok: false, url: null, error: error?.code ?? 'TUNNEL_FAILED', message: error?.message ?? String(error) };
    }
  }

  async disconnect() {
    try {
      await this.tunnel.stop();
    } catch { /* nothing to stop */ }
    await this.auth.revokeAll();
    await this.pairing.revoke();
  }

  bootPromptSync() {
    return buildBootPrompt({
      workspaceName: this.workspace?.name ?? 'the current workspace',
      connectorName: this.connectorName,
      maxIterations: this.config.maxIterations,
    });
  }

  async bootPrompt() {
    const info = await this.workspace.info();
    return {
      connectorName: this.connectorName,
      mcpUrl: this.mcpUrl,
      bootPrompt: buildBootPrompt({
        workspaceName: info.name,
        connectorName: this.connectorName,
        maxIterations: this.config.maxIterations,
      }),
    };
  }

  /** Install the protocol into the agent's system prompt. */
  registerPrompt() {
    // Sit right after the MCP server listing: the connector ChatGPT drives is one of
    // those servers, so the protocol rules read naturally in place.
    const order = this.ctx.systemPrompt.getSectionOrder?.('MCP_SERVERS') ?? 3100;
    return this.ctx.systemPrompt.section({
      name: 'dsh-with-chatgpt',
      order: Number.isFinite(order) ? order + 10 : 3110,
      interpolate: false,
      text: () => PROMPT_TEXT(this),
    });
  }

  /** Slash commands: /chatgpt setup | status | plan | disconnect. */
  registerCommands() {
    const disposers = [];
    const add = (definition) => {
      try {
        disposers.push(this.ctx.commands.register(definition));
      } catch (error) {
        this.log.warn?.(`cannot register command "${definition.name}": ${error?.message ?? error}`);
      }
    };
    add({
      name: 'chatgpt',
      description: 'Connect this workspace to ChatGPT for planning and review (setup | status | disconnect).',
      input: { hint: 'setup | status | disconnect' },
      handler: async (invocation) => {
        const arg = String(invocation.rawInput ?? '').trim().toLowerCase() || 'setup';
        if (arg === 'setup' || arg === 'connect') {
          const result = await this.setupAction('setup');
          const code = result.pairingCode ? `配对码：**${result.pairingCode}**\n` : '';
          return {
            kind: 'success',
            text: [
              this.checklist(result),
              '',
              `连接器名称：${this.connectorName}`,
              `连接器地址：${result.mcpUrl}`,
              code,
              '在 ChatGPT 里添加这个连接器（设置 → 连接器 → 创建），打开页面后输入上面这串配对码。',
              '只填这一个值，别把地址写进 Project 说明。',
            ].join('\n'),
          };
        }
        if (arg === 'disconnect') {
          await this.disconnect();
          return { kind: 'success', text: '已断开 ChatGPT 对该项目的访问。' };
        }
        return { kind: 'success', text: this.checklist(await this.setupAction('status')) };
      },
    });
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* already disposed */ }
      }
    };
  }

  /**
   * `/license` — the only command an unlicensed install has. It prints the machine
   * code (what a buyer sends the seller) and accepts a key, so the whole purchase
   * flow works from the composer without opening Settings.
   */
  registerLicenseCommand() {
    const disposers = [];
    const add = (definition) => {
      try {
        disposers.push(this.ctx.commands.register(definition));
      } catch (error) {
        this.log.warn?.(`cannot register command "${definition.name}": ${error?.message ?? error}`);
      }
    };
    add({
      name: 'license',
      description: 'Show this machine code, or activate the plugin: /license [key]',
      input: { hint: 'leave empty for status, or paste a key' },
      handler: async (invocation) => {
        const typed = String(invocation.rawInput ?? '').trim();
        if (typed !== '') {
          const result = await this.license.activate(typed);
          if (!result.ok) return { kind: 'error', text: `${reasonText(result.reason)}（${result.reason}）` };
          await this.resumeAfterActivation();
          return { kind: 'success', text: `已激活（${result.status.edition}）。机器码 ${result.status.machineCode}。` };
        }
        const status = this.license.status();
        return {
          kind: 'success',
          text: [
            status.active
              ? `已激活（${status.edition}${status.customer ? `，客户 ${status.customer}` : ''}）`
              : `未激活：${reasonText(status.reason)}（${status.reason}）`,
            `机器码：${status.machineCode}`,
            `备用机器码：${status.machineRecovery}`,
            status.active ? '' : '把这个机器码发给卖家换取密钥，然后用 /license <密钥> 激活。',
          ].filter((line) => line !== '').join('\n'),
        };
      },
    });
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* already disposed */ }
      }
    };
  }

  rememberAgent(exec, taskId) {
    try {
      const agent = exec?.agent;
      if (!agent) return;
      const session = agent.session;
      if (!session) return;
      this.log.debug?.(`c2c start from agent ${String(agent.id)} for ${taskId}`);
    } catch { /* the agent may not expose a session; irrelevant */ }
  }

  /**
   * The upstream loop budget is a soft stop: on reaching `maxIterations` the agent
   * pauses and asks the user instead of silently continuing. Accepts a session-like
   * object or a bare iteration number; returns a note at the budget, else null.
   */
  budgetWarning(sessionOrIteration) {
    const limit = Number(this.config.maxIterations) || 12;
    const iteration = typeof sessionOrIteration === 'number'
      ? sessionOrIteration
      : Number(sessionOrIteration?.iteration) || 0;
    if (iteration + 1 < limit) return null;
    return `iteration budget reached (${iteration + 1}/${limit}): pause and ask the user whether to continue or stop.`;
  }

  async dispose() {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch { /* already disposed */ }
    }
    try {
      await this.tunnel?.stop?.();
    } catch { /* nothing to stop */ }
    try {
      await this.http?.stop?.();
    } catch { /* listener already gone */ }
    this.localOrigin = undefined;
  }
}

function PROMPT_TEXT(bridge) {
  const workspace = bridge.workspace?.name ?? 'the current workspace';
  return [
    '## DSH with ChatGPT (C2C)',
    '',
    `This workspace can be planned and reviewed by ChatGPT through a read-only MCP connector named "${bridge.connectorName}".`,
    'ChatGPT thinks; you execute. ChatGPT cannot write, run commands or read file bodies except through that connector.',
    '',
    'Rules:',
    '- Never paste file contents, diffs or logs into ChatGPT. ChatGPT reads the workspace through MCP.',
    '- Never show the user MCP/OAuth/PKCE/tunnel/port internals. Say "连接 ChatGPT", "安全连接", "配对".',
    '- The pairing code is the only credential you may type into a browser.',
    '- Control messages start with [C2C] and are tiny: INIT, PLAN, EXECUTED, REVIEW, DONE, BLOCKED, HANDOFF.',
    `- Loop: c2c_start (INIT) → wait for ChatGPT's PLAN (c2c_inbox) → execute with your own tools → c2c_record → c2c_executed → wait for review → repeat. Respect maxIterations (${bridge.config.maxIterations}).`,
    '- On DONE: summarize for the user in plain language and clear the checkpoint with c2c_session action="clear".',
    '- On BLOCKED: surface the one decision the user must make.',
    '- When the ChatGPT conversation was lost, use c2c_handoff instead of restarting the task.',
    `- Tools: c2c_start, c2c_inbox, c2c_record, c2c_executed, c2c_handoff, c2c_session, c2c_setup.`,
    `- Workspace: ${workspace}. Connector URL: ${bridge.mcpUrl}`,
  ].join('\n');
}

function sessionSnapshot(store) {
  const session = publicSession(store.session);
  return {
    available: true,
    ...session,
    iterations: Number(store.state.counters?.iterations) || 0,
    clients: Object.keys(store.state.clients ?? {}).length,
  };
}

function publicSession(session) {
  if (!session || typeof session !== 'object') return null;
  return {
    taskId: session.taskId ?? null,
    iteration: Number(session.iteration) || 0,
    state: session.state ?? null,
    protocolState: session.protocolState ?? null,
    waitingFor: session.waitingFor ?? null,
    goal: session.goal ?? null,
    nextStep: session.nextStep ?? null,
    knownIssues: session.knownIssues ?? null,
    updatedAt: session.updatedAt ?? null,
  };
}

/** Map an inbound control message onto the next local checkpoint. */
function advanceCheckpoint(session, row) {
  const parsed = parseControlMessage(row.text);
  if (!parsed.ok) return null;
  const local = session?.protocolState ?? 'INIT';
  if (parsed.taskId && session?.taskId && parsed.taskId !== session.taskId) {
    return { knownIssues: `received ${parsed.state} for foreign task ${parsed.taskId}` };
  }
  if (parsed.state === 'PLAN') {
    if (['INIT', 'PLAN_RECEIVED', 'EXECUTING', 'EXECUTED_SENT', 'EXECUTED_LOCAL'].includes(local)) {
      const goal = parsed.fields?.GOAL ? truncate(parsed.fields.GOAL, 1000) : session?.goal;
      // A PLAN that arrives after EXECUTED_SENT opens the next round, so this is
      // where the iteration counter advances. PLAN repeated inside one round keeps
      // the number, which is what makes INIT/PLAN/EXECUTED line up for review.
      const previous = Number(session?.iteration) || 0;
      const iteration = ['EXECUTED_SENT', 'EXECUTED_LOCAL'].includes(local) ? previous + 1 : previous;
      return {
        protocolState: 'PLAN_RECEIVED',
        state: 'PLAN',
        waitingFor: null,
        iteration,
        goal,
        nextStep: 'execute PLAN',
      };
    }
    return { knownIssues: `PLAN arrived while in ${local}` };
  }
  if (parsed.state === 'DONE') {
    return {
      protocolState: 'DONE',
      state: 'DONE',
      waitingFor: null,
      nextStep: 'summarize for the user, then clear the checkpoint',
    };
  }
  if (parsed.state === 'BLOCKED' || parsed.state === 'ERROR') {
    return {
      protocolState: parsed.state === 'ERROR' ? 'ERROR' : 'BLOCKED',
      state: parsed.state,
      waitingFor: 'USER',
      knownIssues: truncate(parsed.fields?.REASON ?? parsed.fields?.SUMMARY ?? 'blocked', 500),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ apply --- */

/**
 * Cordis plugin entry. Everything is registered through `ctx.effect`, so disabling
 * the plugin (or HMR) tears the whole bridge down cleanly.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const bridge = new Bridge({ ctx, config });

  // ONE effect owns the whole bridge: it starts asynchronously and its disposer
  // waits for the start to settle before tearing anything down, so a disable or an
  // HMR reload can never leave half a bridge mounted or a tunnel process behind.
  ctx.effect(() => {
    let live = true;
    const startTask = (async () => {
      try {
        await bridge.start();
        if (!live) return;
        bridge.mount();
        ctx.logger.info(`dsh-with-chatgpt bridge ready: ${bridge.localOrigin}${config.prefix}/mcp (workspace ${bridge.workspace?.root ?? '?'}, state ${stateRoot()})`);
      } catch (error) {
        ctx.logger.error(`dsh-with-chatgpt failed to start: ${error?.stack ?? error?.message ?? error}`);
      }
    })();

    return async () => {
      live = false;
      await startTask.catch(() => undefined);
      await bridge.dispose();
    };
  }, 'dsh-with-chatgpt.bridge');

  // A named service other host code may inject (optional: `provide` needs a
  // reflection-capable context, which the plugin context always is).
  ctx.reflect.provide('dshWithChatgpt', {
    get bridge() {
      return bridge;
    },
    config,
    setup: (action) => bridge.setupAction(action),
    dispose: () => bridge.dispose(),
  });
}

// NOTE: no default export. cordis-plugin-loader unwraps `moduleNamespace.default ?? namespace`,
// so a default export would hand the bare apply function to registry.plugin(), losing the
// named exports (`inject`, `Config`, `name`) that service injection depends on.



// license gate wiring: keep this file changing when the host must re-import.
