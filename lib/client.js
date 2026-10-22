// Settings panel for the ChatGPT bridge. Runs in the DSH web client: the module
// face is `{ inject: ['slots'], apply(ctx) }`, and the panel talks to the host
// over same-origin relative URLs on the bridge prefix.
//
// Two faces, one slot:
//   * no license  — the panel is nothing but an activation form. It shows the key
//                   field, the result of the last attempt, and this machine's id
//                   so support can bind a key to it. Nothing else is rendered,
//                   because nothing else works.
//   * licensed    — a console for the real moving parts: bridge, tunnel, pairing,
//                   connected clients, the [C2C] loop checkpoint, and the tools
//                   ChatGPT sees.
//
// Everything here is plain browser code. The only module it requires is React.
window.__ModuleLoader__.load({
  id: 'dsh-with-chatgpt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Bridge HTTP prefix. Relative on purpose: no leading slash, same origin. */
    const API = 'dsh-with-chatgpt/api';
    /** Fast poll while something is animating, slow poll when idle. */
    const POLL_MS = 3000;
    /** How long a copy button stays in its "copied" state. */
    const COPIED_MS = 1600;

    /* ------------------------------------------------------------ strings --- */

    const DICT = {
      zh: {
        title: 'DSH 接入 ChatGPT',
        subtitle: 'ChatGPT 负责规划与审查，DSH 负责执行。',

        // activation face
        lockTitle: '激活',
        lockLead: '这是一个付费插件。请输入你购买时获得的密钥，激活后即可使用全部功能。',
        keyLabel: '密钥',
        keyPlaceholder: '在此粘贴密钥',
        activate: '激活',
        activating: '正在激活…',
        activateHint: '密钥只在本机校验：不会上传，也不含在你的会话记录里。',
        deactivate: '移除本机授权',
        deactivating: '正在移除…',
        deactivated: '已移除本机授权，重启 DSH 后桥接会关闭。',
        machine: '本机标识',
        machineHint: '联系支持时提供此标识，可为你绑定密钥。',
        edition: '版本',
        entry: '授权编号',
        activatedAt: '激活时间',
        lockedFor: '尝试次数过多，请等待解锁',
        attempts: '剩余尝试次数',

        // console face
        bridge: '桥接服务',
        running: '运行中',
        stopped: '未运行',
        mcpUrl: '连接器地址',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败',
        clickToCopy: '点击复制',
        revealed: '显示',
        hidden: '隐藏',

        tunnel: '公网隧道',
        tunnelMode: '模式',
        tunnelFixed: '固定域名',
        tunnelQuick: '临时地址（重启会变）',
        tunnelOff: '未启动',
        tunnelStarting: '启动中',
        tunnelRunning: '已连接',
        tunnelError: '出错',
        startTunnel: '启动隧道',
        stopTunnel: '停止隧道',
        working: '处理中…',

        pairing: '配对',
        pairingCode: '配对码',
        pairingHint: '在 ChatGPT 的连接器配对页输入这个码。',
        expiresIn: '剩余',
        expired: '已过期',
        attemptsLeft: '次机会',
        locked: '尝试次数用完，请重新生成配对码。',
        generate: '生成配对码',
        generating: '生成中…',
        noPairing: '还没有生效的配对码',

        clients: '已连接客户端',
        clientsNone: '尚未有客户端连接',
        lastUsed: '最近使用',

        loop: '规划循环',
        noLoop: '本轮会话还没有启动过规划循环',
        goal: '目标',
        checkpoint: '检查点',
        iteration: '迭代',
        nextStep: '下一步',
        waitingFor: '等待',
        taskId: '任务',

        toolsTitle: 'ChatGPT 可见的工具',
        toolsAgent: 'DSH 侧（编排循环）',
        toolsMcp: 'ChatGPT 侧（只读）',

        howTo: '首次连接步骤',
        step1: '在上方点「生成配对码」。',
        step2: 'ChatGPT → 设置 → 连接器 → 新建，地址填上面的连接器地址，认证方式选 OAuth。',
        step3: '在配对页输入配对码。之后在 DSH 里说「用 ChatGPT 规划 …」即可。',
        devMode: '若看不到连接器入口，先在 chatgpt.com/#settings/Security 打开开发者模式。',

        scopes: '安全边界',
        scopeA: '连接器只读：没有写入、删除、shell 或提交工具。',
        scopeB: '敏感文件（.env、密钥、SSH）默认拒绝读取。',
        scopeC: '控制消息 < 16 KB，只传意图，不传文件正文。',

        loading: '加载中…',
        unreachable: '无法连接桥接 API，插件可能已停止运行。',
        actionFailed: '操作失败',
        version: '版本',
        none: '未设置',
        yes: '是',
        no: '否',
      },
      en: {
        title: 'DSH with ChatGPT',
        subtitle: 'ChatGPT plans and reviews; DSH executes.',

        lockTitle: 'Activation',
        lockLead: 'This is a paid plugin. Paste the key you received to unlock every feature.',
        keyLabel: 'License key',
        keyPlaceholder: 'Paste your key',
        activate: 'Activate',
        activating: 'Activating…',
        activateHint: 'The key is verified on this machine only — it is never uploaded nor written to your session.',
        deactivate: 'Remove license from this machine',
        deactivating: 'Removing…',
        deactivated: 'License removed. The bridge closes when DSH restarts.',
        machine: 'Machine id',
        machineHint: 'Give this id to support to bind a key to this machine.',
        edition: 'Edition',
        entry: 'License id',
        activatedAt: 'Activated',
        lockedFor: 'Too many attempts — wait for the lockout',
        attempts: 'attempts left',

        bridge: 'Bridge',
        running: 'running',
        stopped: 'stopped',
        mcpUrl: 'Connector URL',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        clickToCopy: 'Click to copy',
        revealed: 'Show',
        hidden: 'Hide',

        tunnel: 'Public tunnel',
        tunnelMode: 'Mode',
        tunnelFixed: 'fixed domain',
        tunnelQuick: 'temporary (changes on restart)',
        tunnelOff: 'not started',
        tunnelStarting: 'starting',
        tunnelRunning: 'connected',
        tunnelError: 'error',
        startTunnel: 'Start tunnel',
        stopTunnel: 'Stop tunnel',
        working: 'Working…',

        pairing: 'Pairing',
        pairingCode: 'Pairing code',
        pairingHint: 'Enter this code on the ChatGPT connector page.',
        expiresIn: 'expires in',
        expired: 'expired',
        attemptsLeft: 'attempts left',
        locked: 'Out of attempts — generate a new code.',
        generate: 'Generate pairing code',
        generating: 'Generating…',
        noPairing: 'No active pairing code',

        clients: 'Connected clients',
        clientsNone: 'No client has connected yet',
        lastUsed: 'last used',

        loop: 'Planning loop',
        noLoop: 'No loop has run in this session yet',
        goal: 'Goal',
        checkpoint: 'Checkpoint',
        iteration: 'Iteration',
        nextStep: 'Next step',
        waitingFor: 'Waiting for',
        taskId: 'Task',

        toolsTitle: 'Tools ChatGPT can see',
        toolsAgent: 'DSH side (drives the loop)',
        toolsMcp: 'ChatGPT side (read-only)',

        howTo: 'First connection',
        step1: 'Press “Generate pairing code” above.',
        step2: 'ChatGPT → Settings → Connectors → Create; paste the connector URL, choose OAuth.',
        step3: 'Enter the pairing code on the pairing page. Then ask “use ChatGPT to plan …”.',
        devMode: 'If the connector entry is missing, enable developer mode at chatgpt.com/#settings/Security.',

        scopes: 'Boundaries',
        scopeA: 'The connector is read-only: no write, delete, shell or commit tool exists.',
        scopeB: 'Sensitive files (.env, keys, SSH) are denied by default.',
        scopeC: 'Control messages stay under 16 KB: intent only, never file bodies.',

        loading: 'Loading…',
        unreachable: 'Cannot reach the bridge API. Is the plugin still running?',
        actionFailed: 'Action failed',
        version: 'version',
        none: 'not set',
        yes: 'yes',
        no: 'no',
      },
    };

    /** Pick the dictionary from the browser language, Chinese first. */
    function pickDict() {
      let lang = '';
      try {
        lang = String(navigator.language || navigator.userLanguage || 'en');
      } catch {
        lang = 'en';
      }
      return lang.toLowerCase().startsWith('zh') ? DICT.zh : DICT.en;
    }

    /* -------------------------------------------------------------- theme --- */

    // Harness theme tokens only, each with a neutral fallback so the panel still
    // renders if a token is missing.
    const theme = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      muted: 'var(--dsw-alias-label-secondary, #666)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.28))',
      surface: 'var(--dsw-alias-settings-card-fill, transparent)',
      inset: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent))',
      brand: 'var(--dsw-alias-brand-primary, #536dfe)',
      error: 'var(--dsw-alias-state-error-primary, #d93025)',
      success: 'var(--dsw-alias-state-success-primary, #1e874b)',
      warn: 'var(--dsw-alias-state-warning-primary, #b26a00)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12))',
      radius: 'var(--dsw-radius-md, 8px)',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
    };

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const S = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '16px',
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radius,
        background: theme.surface,
        color: theme.text,
        fontSize: '13px',
        lineHeight: 1.5,
        boxSizing: 'border-box',
        maxWidth: '760px',
      },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600, color: theme.text },
      sectionHeading: {
        margin: '4px 0 0',
        fontSize: '12px',
        fontWeight: 600,
        color: theme.muted,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      },
      subtitle: { margin: 0, color: theme.muted, fontSize: '12px' },
      rows: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '8px 16px', alignItems: 'baseline' },
      label: { color: theme.muted, whiteSpace: 'nowrap' },
      value: { color: theme.text, display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' },
      mono: { fontFamily: mono, fontSize: '12px', overflowWrap: 'anywhere' },
      badge: (ok) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        border: `1px solid ${ok ? theme.success : theme.border}`,
        color: ok ? theme.success : theme.muted,
      }),
      pill: (tone) => ({
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        border: `1px solid ${tone === 'error' ? theme.error : tone === 'warn' ? theme.warn : theme.border}`,
        color: tone === 'error' ? theme.error : tone === 'warn' ? theme.warn : theme.muted,
      }),
      dot: (ok) => ({
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: ok ? theme.success : theme.faint,
        display: 'inline-block',
      }),
      button: (primary, disabled) => ({
        appearance: 'none',
        border: `1px solid ${primary ? 'transparent' : theme.border}`,
        background: primary ? theme.brand : 'transparent',
        color: primary ? 'var(--dsw-alias-label-primary-inverted, #fff)' : theme.text,
        borderRadius: theme.radiusSm,
        padding: '5px 12px',
        fontSize: '12px',
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }),
      buttonSmall: (disabled) => ({
        appearance: 'none',
        border: `1px solid ${theme.border}`,
        background: 'transparent',
        color: theme.muted,
        borderRadius: theme.radiusSm,
        padding: '2px 8px',
        fontSize: '11px',
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }),
      actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 10px',
        fontFamily: mono,
        fontSize: '13px',
        color: theme.text,
        background: theme.inset,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        outline: 'none',
      },
      error: {
        padding: '8px 10px',
        borderRadius: theme.radiusSm,
        border: `1px solid ${theme.error}`,
        color: theme.error,
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        fontSize: '12px',
        overflowWrap: 'anywhere',
      },
      ok: {
        padding: '8px 10px',
        borderRadius: theme.radiusSm,
        border: `1px solid ${theme.success}`,
        color: theme.success,
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        fontSize: '12px',
      },
      pairing: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px 14px',
        borderRadius: theme.radiusSm,
        border: `1px dashed ${theme.border}`,
        background: theme.inset,
      },
      code: {
        fontFamily: mono,
        fontSize: '26px',
        fontWeight: 600,
        letterSpacing: '0.42em',
        color: theme.text,
        lineHeight: 1.3,
        overflowWrap: 'anywhere',
      },
      meta: { display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px', color: theme.muted },
      steps: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px', color: theme.muted, fontSize: '12px' },
      code2: { fontFamily: mono, color: theme.text },
      list: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '3px' },
      listItem: { display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '12px' },
      footer: { fontSize: '11px', color: theme.faint, borderTop: `1px solid ${theme.border}`, paddingTop: '8px' },
    };

    /* --------------------------------------------------------------- HTTP --- */

    /**
     * The panel is served by the DSH Web GUI on its own port while the bridge
     * listens on a separate loopback port, so a relative URL cannot reach it.
     * Probe the known loopback candidates once, then remember the winner.
     */
    const BASE_KEY = 'dsh-with-chatgpt:api-base';
    /**
     * Loopback ports the bridge may listen on: the plugin default first, then a
     * short window so a custom `port` config still resolves without editing the
     * client bundle. Probing is cheap (parallel, 1.2 s budget).
     */
    const BRIDGE_PORTS = [3780, 3781, 3782, 3783, 3784, 3785];

    let resolvedBase = null;

    function readStoredBase() {
      try {
        return String(window.localStorage.getItem(BASE_KEY) ?? '');
      } catch {
        return '';
      }
    }

    function storeBase(value) {
      try {
        window.localStorage.setItem(BASE_KEY, value);
      } catch {
        /* storage may be denied; the in-memory value is enough */
      }
    }

    function candidateBases() {
      const list = [];
      const stored = readStoredBase();
      if (stored !== '') list.push(stored);
      for (const port of BRIDGE_PORTS) {
        list.push(`http://127.0.0.1:${port}`);
        list.push(`http://localhost:${port}`);
      }
      return list;
    }

    /** Cheap endpoint: always 200 while the bridge is alive, even before activation. */
    async function probeBase(base) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch(`${base}/${API}/license`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }

    async function resolveBase() {
      if (resolvedBase !== null) return resolvedBase;
      const candidates = candidateBases();
      const results = await Promise.all(candidates.map(async (base) => ({ base, ok: await probeBase(base) })));
      // Candidate order encodes preference (stored value first, then default port),
      // so the first hit wins rather than the fastest responder.
      const hit = results.find((entry) => entry.ok);
      if (hit === undefined) throw new Error('bridge unreachable');
      resolvedBase = hit.base;
      storeBase(hit.base);
      return hit.base;
    }

    /** Resolve a bridge URL against the discovered loopback origin. */
    function apiUrl(path, base) {
      return `${base}/${API}${path}`;
    }

    /**
     * JSON request against the bridge; rejects on non-2xx.
     * @param {string} path path below the bridge API prefix.
     * @param {object} [options] `{ method, body }`.
     * @returns {Promise<object>} parsed body.
     */
    async function request(path, options = {}) {
      const base = await resolveBase();
      const method = options.method === 'POST' ? 'POST' : 'GET';
      const init = { method, headers: { accept: 'application/json' } };
      if (method === 'POST') {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body ?? {});
      }
      const response = await fetch(apiUrl(path, base), init);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const detail = body !== null && typeof body === 'object'
          ? body.message ?? body.error_description ?? body.error ?? response.status
          : response.status;
        const error = new Error(String(detail));
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    }

    /* ------------------------------------------------------------ polling --- */

    /**
     * One shared snapshot poller with ticket-based race protection: a slow response
     * from an older tick can never overwrite a newer one.
     * @param {number} intervalMs refresh interval.
     */
    function createPoller(intervalMs) {
      let state = { loading: true, data: null, error: null };
      let ticket = 0;
      const listeners = new Set();
      let timer = null;

      const emit = () => {
        for (const listener of listeners) listener(state);
      };

      async function refresh() {
        const mine = ++ticket;
        try {
          const data = await request('/state');
          if (mine !== ticket) return;
          state = { loading: false, data, error: null };
        } catch (error) {
          if (mine !== ticket) return;
          state = { loading: false, data: state.data, error: error?.message ?? 'failed' };
        }
        emit();
      }

      return {
        getState: () => state,
        subscribe(listener) {
          listeners.add(listener);
          listener(state);
          if (listeners.size === 1) {
            void refresh();
            timer = setInterval(() => { void refresh(); }, intervalMs);
          }
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0 && timer !== null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
        refresh,
        dispose() {
          listeners.clear();
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    }

    const poller = createPoller(POLL_MS);

    /** Subscribe a component to the shared snapshot. */
    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(() => poller.getState());
      useEffect(() => poller.subscribe(setSnapshot), []);
      return [snapshot, poller.refresh];
    }

    /** A 1 Hz clock for countdowns, only while `enabled`. */
    function useNow(enabled) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        if (!enabled) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [enabled]);
      return now;
    }

    /* ---------------------------------------------------------- components --- */

    /** Copy-to-clipboard button with a transient "copied" state. */
    function CopyButton({ value, t, label }) {
      const [state, setState] = useState('idle');
      const timer = useRef(null);
      useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
      const onClick = useCallback(async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(String(value));
          } else {
            throw new Error('no clipboard');
          }
          setState('copied');
        } catch {
          setState('failed');
        }
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), COPIED_MS);
      }, [value]);
      const text = state === 'copied' ? t.copied : state === 'failed' ? t.copyFailed : (label ?? t.copy);
      return h('button', {
        type: 'button',
        onClick,
        style: S.buttonSmall(false),
        title: t.clickToCopy ?? text,
      }, text);
    }

    /** A masked value with a reveal toggle (license ids, machine ids). */
    function Masked({ value, t }) {
      const [shown, setShown] = useState(false);
      if (!value) return h('span', { style: { color: theme.faint } }, t.none);
      const masked = `${String(value).slice(0, 6)}…${String(value).slice(-4)}`;
      return h('span', { style: S.value },
        h('span', { style: S.mono }, shown ? String(value) : masked),
        h('button', {
          type: 'button',
          style: S.buttonSmall(false),
          onClick: () => setShown((current) => !current),
        }, shown ? t.hidden : t.revealed));
    }

    function Row({ label, children }) {
      return [
        h('div', { key: `l:${label}`, style: S.label }, label),
        h('div', { key: `v:${label}`, style: S.value }, children),
      ];
    }

    /* -------------------------------------------------------- activation --- */

    /**
     * The only face an unlicensed user sees: one field, one button, the reason the
     * last attempt failed, and this machine's id for support.
     */
    function ActivationPanel({ snapshot, refresh, t }) {
      const [key, setKey] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const license = snapshot?.data?.license ?? snapshot?.data ?? {};
      const reason = String(license.reason ?? '');
      const lockedUntil = license.lockedUntil === null || license.lockedUntil === undefined ? null : Date.parse(license.lockedUntil);
      const locked = lockedUntil !== null && Number.isFinite(lockedUntil) && lockedUntil > Date.now();
      useNow(locked);

      const submit = useCallback(async (event) => {
        if (event?.preventDefault) event.preventDefault();
        const value = key.trim();
        if (value === '' || busy) return;
        setBusy(true);
        setError('');
        try {
          await request('/license', { method: 'POST', body: { action: 'activate', key: value } });
          setKey('');
          await refresh();
        } catch (failure) {
          const body = failure?.body ?? null;
          setError(String(body?.message ?? failure?.message ?? t.actionFailed));
          await refresh();
        } finally {
          setBusy(false);
        }
      }, [key, busy, refresh, t]);

      const message = error !== '' ? error : (reason !== '' && reason !== 'NOT_ACTIVATED' ? String(license.message ?? '') : '');

      return h('div', { style: S.card },
        h('h3', { style: S.heading }, `${t.title} · ${t.lockTitle}`),
        h('p', { style: S.subtitle }, t.lockLead),
        h('form', { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('label', { style: S.label, htmlFor: 'dsh-with-chatgpt-key' }, t.keyLabel),
            h('input', {
              id: 'dsh-with-chatgpt-key',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t.keyPlaceholder,
              value: key,
              disabled: busy || locked,
              onChange: (event) => setKey(event.target.value),
              style: S.input,
            })),
          message !== ''
            ? h('div', { style: S.error }, message)
            : null,
          locked
            ? h('div', { style: S.error }, `${t.lockedFor}（${new Date(lockedUntil).toLocaleTimeString()}）`)
            : null,
          h('div', { style: S.actions },
            h('button', {
              type: 'submit',
              disabled: busy || locked || key.trim() === '',
              style: S.button(true, busy || locked || key.trim() === ''),
            }, busy ? t.activating : t.activate),
            Number.isFinite(license.attemptsLeft)
              ? h('span', { style: { ...S.meta, color: theme.faint } }, `${license.attemptsLeft} ${t.attempts}`)
              : null)),
        h('p', { style: { ...S.subtitle, color: theme.faint } }, t.activateHint),
        h('div', { style: S.rows },
          Row({ label: t.machine, children: h('span', { style: S.value },
            h('span', { style: S.mono }, String(license.machineId ?? '—')),
            h(CopyButton, { value: String(license.machineId ?? ''), t })) })),
        h('p', { style: { ...S.subtitle, color: theme.faint } }, t.machineHint),
        h('div', { style: S.footer }, `${t.version} ${String(snapshot?.data?.version ?? '—')}`));
    }

    /* ----------------------------------------------------------- console --- */

    /** Tunnel block: mode, live state, URL, and start/stop. */
    function TunnelBlock({ snapshot, refresh, t, run }) {
      const tunnel = snapshot?.data?.tunnel ?? {};
      const state = String(tunnel.state ?? 'stopped');
      const running = state === 'running' || tunnel.running === true;
      const url = typeof tunnel.url === 'string' && tunnel.url !== '' ? tunnel.url : '';
      const label = state === 'running' ? t.tunnelRunning
        : state === 'starting' ? t.tunnelStarting
          : state === 'error' ? t.tunnelError
            : t.tunnelOff;
      const tone = state === 'error' ? 'error' : state === 'starting' ? 'warn' : null;
      const mode = String(tunnel.mode ?? '');
      const modeText = mode === 'named' ? t.tunnelFixed : mode === 'quick' ? t.tunnelQuick : (mode || t.none);

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('h4', { style: S.sectionHeading }, t.tunnel),
        h('div', { style: S.rows },
          Row({ label: t.tunnelMode, children: [h('span', { key: 'm', style: S.mono }, modeText)] }),
          Row({ label: t.bridge, children: [
            h('span', { key: 'p', style: S.pill(tone) }, label),
            running && url !== '' ? h(CopyButton, { key: 'c', value: url, t }) : null,
          ] })),
        running && url !== ''
          ? h('div', { style: S.value }, h('span', { style: S.mono }, url))
          : null,
        state === 'error' && typeof tunnel.error === 'string'
          ? h('div', { style: S.error }, tunnel.error)
          : null,
        h('div', { style: S.actions },
          h('button', {
            type: 'button',
            style: S.button(false, run.busy),
            disabled: run.busy,
            onClick: () => run.do(running ? '/disconnect' : '/connect'),
          }, run.busy ? t.working : (running ? t.stopTunnel : t.startTunnel))));
    }

    /** Pairing block: the code, its countdown, and the generate action. */
    function PairingBlock({ snapshot, refresh, t, run }) {
      const pairing = snapshot?.data?.pairing ?? {};
      const code = typeof pairing.code === 'string' ? pairing.code : '';
      const active = pairing.active === true && code !== '';
      const expiresAt = pairing.expiresAt === null || pairing.expiresAt === undefined ? null : Date.parse(pairing.expiresAt);
      const now = useNow(active);
      const remaining = expiresAt === null || !Number.isFinite(expiresAt) ? 0 : Math.max(0, expiresAt - now);
      const expired = active && remaining === 0;
      const locked = pairing.locked === true;

      return h('div', { style: S.pairing },
        h('h4', { style: { ...S.sectionHeading, margin: 0 } }, t.pairing),
        active && !expired
          ? h('div', { style: S.code }, code)
          : h('div', { style: { ...S.subtitle, color: theme.faint } }, expired ? t.expired : t.noPairing),
        active && !expired
          ? h('div', { style: S.meta },
            h('span', null, `${t.expiresIn} ${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0')}`),
            Number.isFinite(pairing.attemptsLeft) ? h('span', null, `${pairing.attemptsLeft} ${t.attemptsLeft}`) : null,
            h(CopyButton, { value: code, t }))
          : null,
        locked ? h('div', { style: S.error }, t.locked) : null,
        h('p', { style: { ...S.subtitle, color: theme.faint, margin: 0 } }, t.pairingHint),
        h('div', { style: S.actions },
          h('button', {
            type: 'button',
            style: S.button(true, run.busy),
            disabled: run.busy,
            onClick: () => run.do('/pairing'),
          }, run.busy ? t.generating : t.generate)));
    }

    /** The [C2C] loop checkpoint, when a loop has run. */
    function LoopBlock({ snapshot, t }) {
      const session = snapshot?.data?.session ?? null;
      if (session === null || typeof session !== 'object' || (session.taskId ?? '') === '') {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('h4', { style: S.sectionHeading }, t.loop),
          h('p', { style: { ...S.subtitle, color: theme.faint, margin: 0 } }, t.noLoop));
      }
      const iterations = Number(snapshot?.data?.iterations) || 0;
      const max = Number(snapshot?.data?.maxIterations) || 0;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('h4', { style: S.sectionHeading }, t.loop),
        h('div', { style: S.rows },
          Row({ label: t.taskId, children: [h('span', { key: 't', style: S.mono }, String(session.taskId ?? ''))] }),
          Row({ label: t.checkpoint, children: [h('span', { key: 'c', style: S.pill(null) }, String(session.protocolState ?? session.state ?? t.none))] }),
          Row({ label: t.iteration, children: [h('span', { key: 'i', style: S.mono }, max > 0 ? `${iterations} / ${max}` : String(iterations))] }),
          session.goal ? Row({ label: t.goal, children: [h('span', { key: 'g' }, String(session.goal))] }) : null,
          session.waitingFor ? Row({ label: t.waitingFor, children: [h('span', { key: 'w', style: S.mono }, String(session.waitingFor))] }) : null,
          session.nextStep ? Row({ label: t.nextStep, children: [h('span', { key: 'n' }, String(session.nextStep))] }) : null));
    }

    /** Connected ChatGPT clients. */
    function ClientsBlock({ snapshot, t }) {
      const clients = Array.isArray(snapshot?.data?.clients) ? snapshot.data.clients : [];
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('h4', { style: S.sectionHeading }, t.clients),
        clients.length === 0
          ? h('p', { style: { ...S.subtitle, color: theme.faint, margin: 0 } }, t.clientsNone)
          : h('ul', { style: S.list },
            clients.map((client, index) => h('li', { key: String(client?.clientId ?? index), style: S.listItem },
              h('span', { style: S.dot(true) }),
              h('span', { style: S.mono }, String(client?.clientName ?? client?.clientId ?? '—')),
              h('span', { style: { color: theme.faint } },
                `${t.lastUsed} ${client?.lastUsedAt ? new Date(client.lastUsedAt).toLocaleString() : '—'}`)))));
    }

    /** What ChatGPT and the agent can actually call. */
    function ToolsBlock({ t }) {
      const agent = ['c2c_start', 'c2c_inbox', 'c2c_record', 'c2c_executed', 'c2c_handoff', 'c2c_session', 'c2c_setup', 'c2c_license'];
      const mcp = ['workspace_info', 'list_directory', 'read_file', 'search_workspace', 'git_status', 'git_diff',
        'test_status', 'execution_summary', 'execution_output', 'read_image', 'control_submit', 'control_inbox'];
      const list = (ids) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
        ids.map((id) => h('code', { key: id, style: { ...S.mono, background: theme.inset, padding: '1px 6px', borderRadius: theme.radiusSm } }, id)));
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('h4', { style: S.sectionHeading }, t.toolsTitle),
        h('div', { style: { ...S.subtitle, color: theme.muted } }, t.toolsAgent),
        list(agent),
        h('div', { style: { ...S.subtitle, color: theme.muted, marginTop: '4px' } }, t.toolsMcp),
        list(mcp));
    }

    /**
     * The licensed console. It renders only facts the bridge published in its last
     * snapshot — no optimistic state, so what you see is what the host reported.
     */
    function ConsolePanel({ snapshot, refresh, t }) {
      const [run, setRun] = useState({ busy: false, error: '' });
      const [notice, setNotice] = useState('');

      const doAction = useCallback(async (path, body) => {
        setRun({ busy: true, error: '' });
        setNotice('');
        try {
          await request(path, { method: 'POST', body: body ?? {} });
          await refresh();
        } catch (error) {
          const detail = error?.body?.error_description ?? error?.message ?? t.actionFailed;
          setRun({ busy: false, error: String(detail) });
          return;
        }
        setRun({ busy: false, error: '' });
      }, [refresh, t]);

      const remove = useCallback(async () => {
        setRun({ busy: true, error: '' });
        try {
          await request('/license', { method: 'POST', body: { action: 'deactivate' } });
          setNotice(t.deactivated);
          await refresh();
        } catch (error) {
          setRun({ busy: false, error: String(error?.message ?? t.actionFailed) });
          return;
        }
        setRun({ busy: false, error: '' });
      }, [refresh, t]);

      const bridge = snapshot?.data?.bridge ?? {};
      const workspace = snapshot?.data?.workspace ?? {};
      const license = snapshot?.data?.license ?? {};
      const mcpUrl = typeof bridge.mcpUrl === 'string' ? bridge.mcpUrl : '';

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' } },
          h('h3', { style: S.heading }, t.title),
          h('span', { style: S.badge(license.active === true) },
            `${t.edition} ${String(license.edition ?? '—')} · ${String(license.entryId ?? '—')}`)),
        h('p', { style: S.subtitle }, t.subtitle),

        notice !== '' ? h('div', { style: S.ok }, notice) : null,
        run.error !== '' ? h('div', { style: S.error }, run.error) : null,

        h('div', { style: S.rows },
          Row({ label: t.bridge, children: [
            h('span', { key: 'p', style: S.pill(bridge.running === true ? null : 'error') },
              bridge.running === true ? t.running : t.stopped),
            h('span', { key: 'w', style: { ...S.subtitle, color: theme.faint } },
              `${workspace.name ?? '—'} · ${workspace.root ?? '—'}`),
          ] }),
          Row({ label: t.mcpUrl, children: mcpUrl === ''
            ? [h('span', { key: 'x', style: { color: theme.faint } }, t.none)]
            : [
              h('span', { key: 'u', style: S.mono }, mcpUrl),
              h(CopyButton, { key: 'c', value: mcpUrl, t }),
            ] })),

        h(TunnelBlock, { snapshot, refresh, t, run: { busy: run.busy, do: doAction } }),
        h(PairingBlock, { snapshot, refresh, t, run: { busy: run.busy, do: doAction } }),
        h(ClientsBlock, { snapshot, t }),
        h(LoopBlock, { snapshot, t }),
        h(ToolsBlock, { t }),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h4', { style: S.sectionHeading }, t.howTo),
          h('ol', { style: S.steps },
            h('li', null, t.step1),
            h('li', null, t.step2),
            h('li', null, t.step3)),
          h('p', { style: { ...S.subtitle, color: theme.faint, margin: 0 } }, t.devMode)),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('h4', { style: S.sectionHeading }, t.scopes),
          h('ul', { style: S.steps },
            h('li', null, t.scopeA),
            h('li', null, t.scopeB),
            h('li', null, t.scopeC))),

        h('div', { style: S.rows },
          Row({ label: t.activatedAt, children: [
            h('span', { key: 'a', style: S.mono },
              license.activatedAt ? new Date(license.activatedAt).toLocaleString() : t.none),
          ] }),
          Row({ label: t.machine, children: [h(Masked, { value: String(license.machineId ?? ''), t })] })),

        h('div', { style: S.actions },
          h('button', {
            type: 'button',
            style: S.button(false, run.busy),
            disabled: run.busy,
            onClick: (event) => {
              event.preventDefault();
              void remove();
            },
          }, run.busy ? t.deactivating : t.deactivate)),

        h('div', { style: S.footer },
          `${t.version} ${String(snapshot?.data?.version ?? '—')} · ${t.machine} ${String(license.machineId ?? '—')}`));
    }

    /* ------------------------------------------------------------- panel --- */

    function Panel() {
      const t = useMemo(() => pickDict(), []);
      const [snapshot, refresh] = useSnapshot();

      if (snapshot.loading && snapshot.data === null) {
        return h('div', { style: S.card }, h('p', { style: S.subtitle }, t.loading));
      }
      if (snapshot.data === null) {
        // The bridge listener is up as soon as the plugin activates, so a total
        // failure here means the plugin is not running at all.
        return h('div', { style: S.card },
          h('h3', { style: S.heading }, t.title),
          h('div', { style: S.error }, `${t.unreachable}${snapshot.error ? ` (${snapshot.error})` : ''}`));
      }
      const licensed = snapshot.data.licensed === true || snapshot.data.license?.active === true;
      return licensed
        ? h(ConsolePanel, { snapshot, refresh, t })
        : h(ActivationPanel, { snapshot, refresh, t });
    }

    /* -------------------------------------------------------------- face --- */

    return {
      inject: ['slots'],
      apply(ctx) {
        // Refresh on a timer only while a panel is mounted; the poller starts on the
        // first subscriber and stops on the last.
        try {
          ctx.effect(() => () => poller.dispose(), 'dsh-with-chatgpt.poll');
        } catch {
          // A non-web host has no effect scope; the poller is ref-counted anyway.
        }
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-with-chatgpt',
            order: 120,
            label: () => 'ChatGPT',
          }, Panel));
        } catch {
          // No slots service (non-web host): nothing to render into.
        }
      },
    };
  },
});
