# DSH with ChatGPT

**ChatGPT thinks. DSH works.**

A DSH plugin version of [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt):
ChatGPT web becomes the planning and review layer for one local workspace, while the
DSH agent keeps execution ownership — edits, shell, git, tests.

No API key. No reverse proxy. ChatGPT reaches the workspace through a read-only MCP
connector over an official cloudflared tunnel, using the ChatGPT subscription you
already pay for.

- Workspace is the boundary: every path resolves inside the configured root.
- The connector is read-only by construction: write / delete / shell / commit tools do not exist.
- OAuth 2.1 (PKCE S256, dynamic client registration, rotating refresh tokens) plus a
  one-time pairing code — the only credential a user ever types.
- Control messages stay under 1 KB: intent, never content. No diffs, no logs, no file bodies.

## Install

```powershell
dsh plugin install E:\插件\dsh-with-chatgpt
```

`E:\插件` can be any folder — install from wherever you cloned this repo:

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

or through the plugin manager with the absolute bundle directory. The plugin appears as
**DSH with ChatGPT** in Settings → Plugins and adds a **ChatGPT** settings page.

Requirements: Node.js >= 22, `cloudflared` on `PATH` (or the Windows default
`C:\Program Files (x86)\cloudflared\cloudflared.exe`).

## Use

```text
/chatgpt setup        # open the tunnel, mint a pairing code, print the checklist
/chatgpt status       # same checklist without changing anything
/chatgpt disconnect   # revoke every token and stop the tunnel
```

`/chatgpt setup` prints six lines, each derived from live state:

```text
DSH with ChatGPT
✓ 当前项目已识别（my-project）
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 配对码已生成
Ready.
```

Then, in ChatGPT:

1. Settings → Connectors → Create. Description
   `Securely connect ChatGPT to the current DSH workspace for planning and review.`,
   URL = the printed connector URL, Authentication = **OAuth**.
   (Developer mode may be required: `chatgpt.com/#settings/Security`.)
2. Open the connector; the pairing page asks for the code printed above.
3. Paste the Project instructions (also printed by `c2c_setup`) into the ChatGPT Project.
   Never put the connector URL into the Project instructions — only the connector name.

From then on, ask for `使用 ChatGPT 规划` / `用 ChatGPT 规划`. The agent calls `c2c_start`,
and the loop runs:

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT sends `PLAN`/`DONE`/`BLOCKED`/`HANDOFF` through `control_submit`; the DSH agent
drains them with `c2c_inbox`. Iteration budget defaults to 12; on reaching it the agent
pauses and asks.

## Tools

The plugin registers two groups.

**Agent tools (DSH side, orchestrating the loop)**

| Tool | Purpose |
|---|---|
| `c2c_start` | Start a loop: task id + INIT message + boot prompt |
| `c2c_inbox` | Drain ChatGPT's PLAN/DONE/BLOCKED/HANDOFF, advance the checkpoint |
| `c2c_record` | Record the execution (files, tests, sanitized output) |
| `c2c_executed` | Build the EXECUTED message (counts and test line only) |
| `c2c_handoff` | Recover a lost ChatGPT conversation with a 1 KB brief |
| `c2c_session` | Read / set / clear the local checkpoint |
| `c2c_setup` | Status, tunnel, pairing code, Project instructions |

**MCP tools (ChatGPT side, read-only)**

`workspace_info`, `list_directory`, `read_file`, `search_workspace`, `git_status`,
`git_diff`, `test_status`, `execution_summary`, `execution_output`, `read_image`,
plus `control_submit` / `control_inbox` for the control plane.

Sensitive files (`.env*`, keys, SSH material, credentials) are denied by default —
`.env.example` stays readable. `.c2cignore` adds project-specific rules. Command output
is sanitized locally before ChatGPT can see it; private keys and tokens are withheld
entirely, and restricted items appear in the list with no body.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the plugin off without uninstalling |
| `workspace` | `''` | Workspace root; empty = the session working directory |
| `prefix` | `/dsh-with-chatgpt` | HTTP mount point, kept relative so the endpoint survives a port change |
| `connectorName` | `''` | ChatGPT connector label; empty = `DSH with ChatGPT (<workspace>)` |
| `maxIterations` | `12` | Soft loop budget before pausing for the user |
| `autoStartTunnel` | `false` | Start the public tunnel with the bridge |
| `tunnel` | `quick` | `quick` (`*.trycloudflare.com`, changes on restart) or `named` |
| `cloudflaredPath` | `''` | Explicit binary path |
| `publicOrigin` | `''` | Fixed public origin (e.g. `https://dsh.example.com`) when the tunnel is externally managed; the bridge reports this URL instead of spawning its own child |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | Named-tunnel options: a token (remote-managed ingress) **or** a local config file + tunnel name (`--config <path> … run <name>`); hostname sets the reported URL |
| `limits` | see below | `maxFileBytes` 128 KiB, `maxDiffBytes` 96 KiB, `maxOutputBytes` 64 KiB, `maxOutputLines` 600, `maxImageBytes` 4 MiB |

### Fixed domain (optional)

A quick tunnel URL changes every restart. For a stable connector URL, create a named
tunnel once:

```powershell
cloudflared tunnel login
cloudflared tunnel create my-bridge
cloudflared tunnel route dns my-bridge dsh.example.com
```

Write `~/.cloudflared/bridge.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:/Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3780
  - service: http_status:404
```

Run it (e.g. a scheduled task at logon), then set in `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-with-chatgpt
      name: dsh-with-chatgpt
      config:
        publicOrigin: 'https://dsh.example.com'
        autoStartTunnel: false   # the external supervisor owns the tunnel
        tunnel:
          mode: named
          tunnelName: my-bridge
          configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
```

State lives in `$DSH_HOME/dsh-with-chatgpt` (mode 0700, atomic writes), never in the
workspace: OAuth clients and hashed tokens, the control journal, execution records and
sanitized output. Deleting that directory is a full reset.

## Differences from the original

The upstream project ships a Node CLI plus a Codex Skill, and drives the ChatGPT side by
typing `[C2C]` messages into the web UI. DSH has no browser-automation surface, so this
plugin replaces that half with two control-plane MCP tools:

| Upstream | Here |
|---|---|
| `c2c setup` / `c2c status` CLI | `/chatgpt` command + settings page + `c2c_setup` tool |
| Codex Skill file | `systemPrompt` section installed by the plugin |
| "Computer Use" types into ChatGPT | `control_submit` / `control_inbox` MCP tools |
| `c2c record` / `session --json` | `c2c_record`, `c2c_session` tools + JSONL journal |
| Desktop status screen | Settings → **ChatGPT** panel (React slot, DSH theme tokens) |

Same protocol, same message format, same security posture, same 13-rule boot prompt —
so the ChatGPT half is unchanged and the docs upstream still apply.

## Security

- The MCP endpoint always requires an OAuth bearer token, because the tunnel makes it
  publicly reachable.
- The state API (`/api/*`) answers loopback only, and additionally refuses any request
  carrying tunnel headers, a non-loopback `Host`, or a cross-site `Origin` — a
  `cloudflared` request also arrives from a loopback socket, so the socket check alone
  would not be enough.
- Pairing codes are 8 symbols, 5-minute TTL, one-time, 5 attempts, rate limited per IP.
- Refresh-token replay revokes the whole token family.
- Path containment uses `realpathSync.native` so NTFS junctions cannot escape the root.

## Tests

```powershell
node --test --experimental-test-isolation=none tests/auth.test.js
node --test --experimental-test-isolation=none tests/mcp.test.js
node --test --experimental-test-isolation=none tests/tunnel.test.js
node --test --experimental-test-isolation=none tests/workspace.test.js
node --test --experimental-test-isolation=none tests/http.test.js
```

`--experimental-test-isolation=none` is only needed inside a sandbox that forbids piped
child stdio; a normal shell runs plain `node --test` fine.

MIT licensed, like the original.
