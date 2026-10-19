// Settings panel for the ChatGPT bridge. Runs in the DSH web client: the
// module face is `{ inject: ['slots'], apply(ctx) }`, and the panel talks to
// the host over same-origin relative URLs on the bridge prefix.
//
// Everything here is plain browser code. The only module it requires is React.
window.__ModuleLoader__.load({
  id: 'dsh-with-chatgpt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Bridge HTTP prefix. Relative on purpose: no leading slash, same origin. */
    const API = 'dsh-with-chatgpt/api';
    /** How often the panel refreshes the bridge snapshot. */
    const POLL_MS = 3000;
    /** How long the copy button stays in its "copied" state. */
    const COPIED_MS = 1600;
    /** Fallback connector name when the host does not publish one. */
    const DEFAULT_CONNECTOR = 'dsh-with-chatgpt';

    /* ------------------------------------------------------------ strings --- */

    const DICT = {
      en: {
        title: 'DSH with ChatGPT',
        subtitle: 'Let ChatGPT drive this DSH session through a local MCP bridge.',
        loading: 'Loading…',
        unreachable: 'Cannot reach the bridge API. Is the plugin still running?',
        bridge: 'Bridge',
        running: 'running',
        stopped: 'stopped',
        mcpUrl: 'MCP URL',
        tunnel: 'Tunnel',
        tunnelOff: 'stopped',
        tunnelStarting: 'starting',
        tunnelRunning: 'running',
        tunnelError: 'error',
        clients: 'Connected clients',
        iterations: 'Iterations',
        protocol: 'Protocol state',
        copy: 'Copy',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        generate: 'Generate pairing code',
        generating: 'Generating…',
        pairingCode: 'Pairing code',
        pairingHint: 'Enter this code on the ChatGPT connector page.',
        expiresIn: 'Expires in',
        expired: 'Expired',
        attemptsLeft: 'attempts left',
        locked: 'Locked after too many failed attempts. Generate a new code.',
        startTunnel: 'Start tunnel',
        stopTunnel: 'Stop tunnel',
        working: 'Working…',
        howTo: 'How to connect',
        step1: 'Open chatgpt.com and sign in.',
        step2: 'Add a connector named "{name}" pointing at the MCP URL above.',
        step3: 'When the page asks for a pairing code, paste the code shown here.',
        none: 'not set',
        authOk: 'paired',
        authNone: 'no clients yet',
        clickToCopy: 'Copy to clipboard',
        actionFailed: 'Action failed',
        version: 'version',
      },
      zh: {
        title: 'DSH 接入 ChatGPT',
        subtitle: '通过本地 MCP 桥接，让 ChatGPT 驱动当前 DSH 会话。',
        loading: '加载中…',
        unreachable: '无法连接桥接 API，插件可能已经停止运行。',
        bridge: '桥接',
        running: '运行中',
        stopped: '已停止',
        mcpUrl: 'MCP 地址',
        tunnel: '隧道',
        tunnelOff: '已停止',
        tunnelStarting: '启动中',
        tunnelRunning: '运行中',
        tunnelError: '出错',
        clients: '已连接客户端',
        iterations: '迭代次数',
        protocol: '协议状态',
        copy: '复制',
        copied: '已复制',
        copyFailed: '复制失败',
        generate: '生成配对码',
        generating: '生成中…',
        pairingCode: '配对码',
        pairingHint: '在 ChatGPT 连接器页面输入这个配对码。',
        expiresIn: '剩余有效期',
        expired: '已过期',
        attemptsLeft: '次尝试机会',
        locked: '失败次数过多已锁定，请重新生成配对码。',
        startTunnel: '启动隧道',
        stopTunnel: '停止隧道',
        working: '处理中…',
        howTo: '连接步骤',
        step1: '打开 chatgpt.com 并登录。',
        step2: '添加名为「{name}」的连接器，地址填入上面的 MCP 地址。',
        step3: '当页面要求输入配对码时，粘贴这里显示的配对码。',
        none: '未设置',
        authOk: '已配对',
        authNone: '暂无客户端',
        clickToCopy: '复制到剪贴板',
        actionFailed: '操作失败',
        version: '版本',
      },
    };

    /** Pick a dictionary from the browser locale; never throws. */
    function pickDict() {
      try {
        const language = typeof navigator !== 'undefined' && navigator !== null ? navigator.language : '';
        return typeof language === 'string' && language.toLowerCase().indexOf('zh') === 0 ? DICT.zh : DICT.en;
      } catch {
        return DICT.en;
      }
    }

    /* -------------------------------------------------------------- theme --- */

    // Only harness theme tokens, each with a neutral fallback so the panel still
    // renders if a token is missing.
    const theme = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, inherit)',
      faint: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit))',
      border: 'var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.28))',
      surface: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1, transparent))',
      inset: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent))',
      brand: 'var(--dsw-alias-brand-primary, #536dfe)',
      error: 'var(--dsw-alias-state-error-primary, #d93025)',
      success: 'var(--dsw-alias-state-success-primary, #1e874b)',
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
      },
      heading: { margin: 0, fontSize: '15px', fontWeight: 600, color: theme.text },
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
      actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
      error: {
        padding: '8px 10px',
        borderRadius: theme.radiusSm,
        border: `1px solid ${theme.error}`,
        color: theme.error,
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        fontSize: '12px',
        overflowWrap: 'anywhere',
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
      footer: { fontSize: '11px', color: theme.faint, borderTop: `1px solid ${theme.border}`, paddingTop: '8px' },
    };

    /* --------------------------------------------------------------- HTTP --- */

    /** Resolve a bridge URL without depending on where the SPA is mounted. */
    function apiUrl(path) {
      return `${API}${path}`;
    }

    /**
     * Same-origin JSON request against the bridge; rejects on non-2xx.
     * @param {string} path path below the bridge API prefix.
     * @param {string} [method] HTTP method.
     * @returns {Promise<object>} parsed body.
     */
    async function request(path, method) {
      const init = { method: method === 'POST' ? 'POST' : 'GET', headers: { accept: 'application/json' } };
      const response = await fetch(apiUrl(path), init);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const detail = body !== null && typeof body === 'object'
          ? body.error_description ?? body.message ?? body.error ?? response.status
          : response.status;
        throw new Error(String(detail));
      }
      return body === null ? {} : body;
    }

    /** Human-readable message for a thrown request error. @param {unknown} error @returns {string} */
    function messageOf(error) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    /* ------------------------------------------------------------- poller --- */

    /**
     * One shared snapshot poller. It is created inside the plugin effect, so
     * plugin teardown stops it; the panel only subscribes while it is mounted.
     * Every request carries a ticket, and a late response is dropped when a
     * newer request has been issued (or the poller was disposed).
     * @returns {object} poller
     */
    function createPoller() {
      let ticket = 0;
      let timer = null;
      let disposed = false;
      const listeners = new Set();
      const view = { snapshot: null, error: null, pending: false, updatedAt: null };

      function publish(patch) {
        if (disposed) return;
        if (patch.snapshot !== undefined) view.snapshot = patch.snapshot;
        if (patch.error !== undefined) view.error = patch.error;
        if (patch.pending !== undefined) view.pending = patch.pending;
        view.updatedAt = Date.now();
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            // A broken subscriber must not stop the poll loop.
          }
        }
      }

      function clear() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
      }

      function schedule(delay) {
        if (disposed || listeners.size === 0) return;
        clear();
        timer = setTimeout(run, delay);
        timer.unref?.();
      }

      async function run() {
        if (disposed || listeners.size === 0) return;
        const mine = ++ticket;
        try {
          const snapshot = await request('/state');
          if (disposed || mine !== ticket) return;
          publish({ snapshot, error: null, pending: false });
        } catch (error) {
          if (disposed || mine !== ticket) return;
          publish({ error: messageOf(error), pending: false });
        }
        if (!disposed && mine === ticket) schedule(POLL_MS);
      }

      function subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        if (listeners.size === 1) {
          publish({ pending: true });
          void run();
        } else {
          listener();
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) clear();
        };
      }

      /** Re-poll immediately, e.g. after a mutating action. */
      function refresh() {
        if (disposed) return;
        ticket += 1;
        clear();
        publish({ pending: true });
        void run();
      }

      function dispose() {
        disposed = true;
        ticket += 1;
        clear();
        listeners.clear();
      }

      return { subscribe, refresh, dispose, getState: () => view };
    }

    /** Shared bindings that apply() fills in when the plugin starts. */
    const runtime = { poll: null, dict: pickDict() };

    /**
     * The plugin-wide poller; created on first use so a late mount after a
     * plugin restart still works.
     * @returns {object} poller
     */
    function ensurePoller() {
      if (runtime.poll === null) runtime.poll = createPoller();
      return runtime.poll;
    }

    /**
     * Subscribe the component to the shared poller.
     * @returns {{snapshot: object|null, error: string|null, pending: boolean}} current view.
     */
    function useBridge() {
      const [poll] = React.useState(() => ensurePoller());
      const [view, setView] = React.useState(() => ({ ...poll.getState() }));
      React.useEffect(() => {
        let alive = true;
        const sync = () => {
          if (alive) setView({ ...poll.getState() });
        };
        const unsubscribe = poll.subscribe(sync);
        sync();
        return () => {
          alive = false;
          unsubscribe();
        };
      }, [poll]);
      return view;
    }

    /** A 1 Hz clock for the pairing countdown; cleaned up on unmount. @returns {number} epoch ms */
    function useNow() {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        let alive = true;
        let handle = null;
        const step = () => {
          if (!alive) return;
          setNow(Date.now());
          handle = setTimeout(step, 1000);
        };
        handle = setTimeout(step, 1000);
        return () => {
          alive = false;
          if (handle !== null) clearTimeout(handle);
        };
      }, []);
      return now;
    }

    /* ------------------------------------------------------------ helpers --- */

    /** @param {number} ms @returns {string} mm:ss */
    function formatClock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    /** @param {unknown} value @returns {boolean} */
    function isTrue(value) {
      return value === true;
    }

    /** @param {unknown} value @returns {string} */
    function textOf(value) {
      return typeof value === 'string' ? value : '';
    }

    /** @param {unknown} list @returns {number} */
    function lengthOf(list) {
      return Array.isArray(list) ? list.length : 0;
    }

    /** @param {unknown} value @returns {number} */
    function numberOr(value, fallback) {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : fallback;
    }

    /* -------------------------------------------------------------- parts --- */

    /**
     * Copyable monospace value with a short "copied" flash.
     * @param {{label: string, value: string, t: object}} props
     * @returns {object} element
     */
    function CopyField({ label, value, t }) {
      const [state, setState] = React.useState('idle');
      const timer = React.useRef(null);
      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current);
      }, []);
      const copy = async () => {
        if (value === '') return;
        try {
          // Clipboard access is permission-gated; a denied or absent API must
          // still leave the panel usable, so both failure modes flash a hint.
          if (typeof navigator === 'undefined' || navigator === null || navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
            throw new Error('clipboard-unavailable');
          }
          await navigator.clipboard.writeText(value);
          setState('copied');
        } catch {
          setState('failed');
        }
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState('idle'), COPIED_MS);
      };
      const buttonLabel = state === 'copied' ? t.copied : state === 'failed' ? t.copyFailed : t.copy;
      return h(
        'div',
        { style: S.value },
        h('span', { style: { ...S.mono, minWidth: 0 } }, value),
        h(
          'button',
          {
            type: 'button',
            onClick: copy,
            title: t.clickToCopy,
            style: S.button(false, false),
            'aria-label': `${t.copy} ${label}`,
          },
          buttonLabel,
        ),
      );
    }

    /**
     * The settings panel itself. Tolerates being rendered with no props.
     * @param {object} [props] slot props (unused, but the shell may pass some).
     * @returns {object} element
     */
    function Panel(props) {
      void props;
      const t = runtime.dict;
      const view = useBridge();
      const now = useNow();
      const [busy, setBusy] = React.useState('');
      const [actionError, setActionError] = React.useState('');

      const snapshot = view.snapshot;
      const bridge = snapshot !== null && typeof snapshot === 'object' && snapshot.bridge !== null && typeof snapshot.bridge === 'object' ? snapshot.bridge : {};
      const tunnel = snapshot !== null && typeof snapshot === 'object' && snapshot.tunnel !== null && typeof snapshot.tunnel === 'object' ? snapshot.tunnel : {};
      const pairing = snapshot !== null && typeof snapshot === 'object' && snapshot.pairing !== null && typeof snapshot.pairing === 'object' ? snapshot.pairing : {};
      const session = snapshot !== null && typeof snapshot === 'object' && snapshot.session !== null && typeof snapshot.session === 'object' ? snapshot.session : {};
      const prompt = snapshot !== null && typeof snapshot === 'object' && snapshot.prompt !== null && typeof snapshot.prompt === 'object' ? snapshot.prompt : {};

      const bridgeRunning = isTrue(bridge.running);
      const bridgePaired = isTrue(bridge.authenticated);
      const tunnelRunning = isTrue(tunnel.running);
      const tunnelState = textOf(tunnel.state) === '' ? (tunnelRunning ? 'running' : 'stopped') : textOf(tunnel.state);
      const tunnelUrl = textOf(tunnel.url);
      const tunnelError = textOf(tunnel.error);
      const tunnelTail = Array.isArray(tunnel.stderrTail) && tunnel.stderrTail.length > 0 ? textOf(tunnel.stderrTail[tunnel.stderrTail.length - 1]) : '';
      const mcpUrl = textOf(bridge.mcpUrl);
      const connectorName = textOf(prompt.connectorName) === '' ? DEFAULT_CONNECTOR : textOf(prompt.connectorName);
      const clients = lengthOf(snapshot !== null && typeof snapshot === 'object' ? snapshot.clients : null);
      const iterations = numberOr(snapshot !== null && typeof snapshot === 'object' ? snapshot.iterations : 0, 0);
      const maxIterations = numberOr(snapshot !== null && typeof snapshot === 'object' ? snapshot.maxIterations : 0, 0);
      const protocolState = textOf(session.protocolState) === '' ? textOf(session.state) : textOf(session.protocolState);
      const version = textOf(snapshot !== null && typeof snapshot === 'object' ? snapshot.version : '');

      const pairingActive = isTrue(pairing.active);
      const pairingCode = textOf(pairing.code);
      const pairingLocked = isTrue(pairing.locked);
      const attemptsLeft = numberOr(pairing.attemptsLeft, 0);
      const expiresAt = Date.parse(textOf(pairing.expiresAt));
      const expiresIn = Number.isFinite(expiresAt) ? expiresAt - now : 0;
      const pairingLive = pairingActive && pairingCode !== '' && expiresIn > 0;
      const pairingExpired = pairingActive && pairingCode !== '' && expiresIn <= 0;

      const run = async (name, path) => {
        if (busy !== '') return;
        setBusy(name);
        setActionError('');
        try {
          await request(path, 'POST');
        } catch (error) {
          setActionError(`${t.actionFailed}: ${messageOf(error)}`);
        } finally {
          setBusy('');
          runtime.poll?.refresh();
        }
      };

      const tunnelLabel = tunnelState === 'running' || tunnelRunning
        ? t.tunnelRunning
        : tunnelState === 'starting'
          ? t.tunnelStarting
          : tunnelState === 'error'
            ? t.tunnelError
            : t.tunnelOff;

      return h(
        'div',
        { style: S.card, 'data-dsh-with-chatgpt': 'panel' },
        h('div', null, h('h3', { style: S.heading }, t.title), h('p', { style: S.subtitle }, t.subtitle)),

        view.error !== null
          ? h('div', { style: S.error, role: 'alert' }, `${t.unreachable} (${view.error})`)
          : null,
        actionError !== ''
          ? h('div', { style: S.error, role: 'alert' }, actionError)
          : null,

        h(
          'div',
          { style: S.rows },
          h('div', { style: S.label }, t.bridge),
          h(
            'div',
            { style: S.value },
            h('span', { style: S.badge(bridgeRunning) }, h('span', { style: S.dot(bridgeRunning) }), bridgeRunning ? t.running : t.stopped),
            h('span', { style: S.badge(bridgePaired) }, bridgePaired ? t.authOk : t.authNone),
          ),
          h('div', { style: S.label }, t.mcpUrl),
          h(CopyField, { key: 'mcp', label: t.mcpUrl, value: mcpUrl === '' ? t.none : mcpUrl, t }),
          h('div', { style: S.label }, t.tunnel),
          h(
            'div',
            { style: S.value },
            h('span', { style: S.badge(tunnelRunning) }, h('span', { style: S.dot(tunnelRunning) }), tunnelLabel),
            tunnelUrl === '' ? h('span', { style: { ...S.mono, color: theme.muted } }, t.none) : h('span', { style: S.mono }, tunnelUrl),
            tunnelRunning && tunnelUrl !== '' ? h(CopyField, { key: 'tunnelcopy', label: t.tunnel, value: tunnelUrl, t }) : null,
          ),
          h('div', { style: S.label }, t.clients),
          h('div', { style: S.value }, String(clients)),
          h('div', { style: S.label }, t.iterations),
          h('div', { style: S.value }, maxIterations > 0 ? `${iterations} / ${maxIterations}` : String(iterations)),
          h('div', { style: S.label }, t.protocol),
          h('div', { style: { ...S.value, ...S.mono } }, protocolState === '' ? t.none : protocolState),
        ),

        tunnelError !== ''
          ? h(
            'div',
            { style: { ...S.error, borderStyle: 'dashed' } },
            tunnelError,
            tunnelTail === '' ? null : h('div', { style: { ...S.mono, marginTop: '4px', opacity: 0.75 } }, tunnelTail),
          )
          : null,

        pairingLive
          ? h(
            'div',
            { style: S.pairing },
            h('div', { style: { ...S.label, fontSize: '12px' } }, t.pairingCode),
            h('div', { style: S.code }, pairingCode),
            h('div', { style: S.meta },
              h('span', null, `${t.expiresIn} ${formatClock(expiresIn)}`),
              attemptsLeft > 0 ? h('span', null, `${attemptsLeft} ${t.attemptsLeft}`) : null,
            ),
            h('div', { style: { ...S.footer, borderTop: 'none', paddingTop: 0 } }, t.pairingHint),
          )
          : pairingExpired
            ? h('div', { style: { ...S.pairing, opacity: 0.6 } },
              h('div', { style: { ...S.label, fontSize: '12px' } }, t.pairingCode),
              h('div', { style: S.code }, pairingCode),
              h('div', { style: S.meta }, h('span', null, t.expired)),
            )
            : pairingLocked
              ? h('div', { style: S.error }, t.locked)
              : null,

        h(
          'div',
          { style: S.actions },
          h(
            'button',
            {
              type: 'button',
              onClick: () => void run('pairing', '/pairing'),
              disabled: busy !== '',
              style: S.button(true, busy !== ''),
              'data-action': 'pairing',
            },
            busy === 'pairing' ? t.generating : t.generate,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void run('connect', '/connect'),
              disabled: busy !== '' || tunnelRunning,
              style: S.button(false, busy !== '' || tunnelRunning),
              'data-action': 'connect',
            },
            busy === 'connect' ? t.working : t.startTunnel,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void run('disconnect', '/disconnect'),
              disabled: busy !== '' || !tunnelRunning,
              style: S.button(false, busy !== '' || !tunnelRunning),
              'data-action': 'disconnect',
            },
            busy === 'disconnect' ? t.working : t.stopTunnel,
          ),
          view.pending ? h('span', { style: { ...S.meta, fontSize: '11px' } }, t.loading) : null,
        ),

        h(
          'div',
          null,
          h('div', { style: { ...S.label, marginBottom: '4px', fontWeight: 600, color: theme.text } }, t.howTo),
          h(
            'ol',
            { style: S.steps },
            h('li', null, t.step1),
            h('li', null, t.step2.replace('{name}', connectorName)),
            h('li', null, t.step3),
          ),
        ),

        version === ''
          ? null
          : h('div', { style: S.footer }, `${DEFAULT_CONNECTOR} · ${t.version} ${version}`),
      );
    }

    /**
     * Register the settings section. Any failure here must leave the harness
     * working, so the inject callback always returns a disposer.
     * @param {object} ctx plugin context supplied by the harness.
     * @returns {void}
     */
    function apply(ctx) {
      // The poller is created inside the plugin effect and disposed with the
      // plugin; the panel only subscribes while it is mounted, so no timer can
      // outlive either the plugin or the last panel.
      try {
        ctx.effect(() => {
          const poll = createPoller();
          runtime.poll = poll;
          return () => {
            if (runtime.poll === poll) runtime.poll = null;
            poll.dispose();
          };
        }, 'dsh-with-chatgpt.poll');
      } catch {
        // No effect host: the poller is created lazily by the panel and stops
        // as soon as the last subscriber unsubscribes.
      }

      try {
        ctx.slots.inject('settings.section', () => {
          try {
            const unregister = ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-with-chatgpt',
                order: 120,
                label: () => 'ChatGPT',
              },
              Panel,
            );
            return () => {
              unregister();
            };
          } catch {
            return () => {};
          }
        });
      } catch {
        // Settings slot is unavailable (non-web host): the MCP endpoint is
        // still served, so degradation is acceptable.
      }
    }

    return { inject: ['slots'], apply };
  },
});
