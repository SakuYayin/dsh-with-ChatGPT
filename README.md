# DSH with ChatGPT

**ChatGPT thinks. DSH works.**

A DSH plugin port of [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt):
ChatGPT web becomes the planning and review brain for your local workspace, while the
DSH agent keeps execution ownership — edits, shell, tests.

No API key, no reverse proxy. ChatGPT reaches your workspace through a **read-only MCP
connector** over an official cloudflared tunnel, using the ChatGPT subscription you
already pay for.

- **Workspace is the boundary**: every path resolves inside the configured root — NTFS
  junctions and symlinks cannot escape.
- **Read-only by construction**: write / delete / shell / commit tools do not exist,
  rather than being "disabled".
- **OAuth 2.1** (PKCE S256, dynamic client registration, rotating refresh tokens with
  family revocation) plus a one-time pairing code — the only credential a user types.
- **Control messages stay under 1 KB**: intent, never content. No diffs, no logs, no
  file bodies.

> 🌐 Other languages: [English](README.md) · [中文](README.zh-CN.md) ·
> [Français](README.fr-FR.md) · [Русский](README.ru-RU.md) ·
> [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

## Licensing

This plugin is **commercial**. It does nothing until it is activated on the machine
that runs it: the ChatGPT tools are not registered, no system-prompt section is
installed, the MCP endpoint answers `402 license_required`, and the tunnel stays down.

Open **Settings → ChatGPT** and paste your key. Activation then unlocks everything
immediately — no DSH restart.

How the check works, and why it holds up:

| Layer | Mechanism |
| --- | --- |
| Key verification | Only a `scrypt` hash (N=32768, r=8, p=1) of each valid key is compiled into `lib/license.js`. No plaintext key exists in the source, so reading the file reveals nothing usable. |
| Durable record | The state file stores the license id, edition and activation time — never the key. |
| Machine binding | The record carries an HMAC-SHA256 tag keyed by hostname + platform + a per-install random id. Copying the state directory to another machine fails with `MACHINE_MISMATCH`. |
| Tamper detection | Editing the edition or the key id in the state file breaks the tag (`RECORD_TAMPERED`). Forging a tag with an unknown key hash still fails (`UNKNOWN_KEY`), because the allowlist check is independent of the tag. |
| Guess resistance | Every comparison is constant-time, and failed attempts arm an exponential lockout (1 s, 2 s, 4 s … capped at 1 h) after the third try. |
| Signed keys | For per-customer keys the plugin ships only an Ed25519 **public** key; licenses are `DSH1.<payload>.<signature>` blobs minted offline with `tools/mint-license.mjs`. |

The gates are deliberately independent: patching the MCP check leaves the tool
registration closed, patching that leaves the prompt and tunnel closed. Removing the
license requirement properly means editing four places plus the record verifier.

Vendor tooling (never shipped to customers):

```bash
node tools/mint-license.mjs --hash 'your-key'      # add a key to the allowlist
node tools/mint-license.mjs --init                 # generate an Ed25519 key pair
node tools/mint-license.mjs --mint --name ACME --days 365
node tools/mint-license.mjs --verify 'DSH1....'
```

## One-command install (Agent instruction)

Once DSH is installed, say this single line to your agent — it covers everything from
clone to enable:

```text
Before using ChatGPT for planning: clone https://github.com/SakuYayin/dsh-with-ChatGPT
locally, install that directory with the plugin manager's install_bundle, then run
/chatgpt setup and tell me the printed connector URL and pairing code.
```

Or step by step (equivalent):

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

After installing, run `/chatgpt setup` in a DSH session (or have the agent call the
`setup` action of the `c2c_setup` tool). It starts the tunnel, mints a pairing code and
prints this checklist:

```text
DSH with ChatGPT
✓ Current project recognized (my-project)
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ Pairing code generated
Ready.
```

## Connect ChatGPT (one-time, ~2 minutes)

1. ChatGPT → **Settings → Connectors → Create**. Description is free-form, URL = the
   connector address printed above, Authentication = **OAuth**
   (Developer mode may be required: `chatgpt.com/#settings/Security`).
2. Open the connector; the pairing page asks for the **8-symbol pairing code** printed
   above (5-minute TTL, one-time).
3. Paste the **Project instructions** (also printed by `c2c_setup`) into the ChatGPT
   Project settings. Only paste the connector **name** — never the connector URL.

From then on, say **"Use ChatGPT to plan <goal>"** in DSH. The agent calls `c2c_start`
and the loop runs:

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT sends `PLAN`/`DONE`/`BLOCKED`/`HANDOFF` through `control_submit`; the DSH agent
drains them with `c2c_inbox`. The iteration budget defaults to 12; on reaching it the
agent pauses and asks.

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
is sanitized locally before ChatGPT can see it: private keys and tokens are withheld
entirely, restricted items appear in listings with no body.

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
| `publicOrigin` | `''` | Fixed public origin when the tunnel is externally managed; the bridge reports this URL instead of spawning its own child |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | Named-tunnel options: a token (remote-managed ingress) **or** a local config file + tunnel name (`--config <path> … run <name>`); hostname sets the reported URL |
| `limits` | see below | `maxFileBytes` 128 KiB, `maxDiffBytes` 96 KiB, `maxOutputBytes` 64 KiB, `maxOutputLines` 600, `maxImageBytes` 4 MiB |

### Choose a tunnel: answer one question

> **"Do I own a domain?"**

```text
        ┌─ Own a domain (e.g. example.com)? ──→ Route A: fixed domain, configure once
        │
        └─ No domain? ───────────────────────→ Route B: quick tunnel, zero config
```

---

#### Route A: you have a domain — 5 steps, configure once forever

What you need: a domain hosted on Cloudflare (the free plan is enough) and a working
`cloudflared`.

> 💡 This is done once. The connector URL never changes again, no matter how many times
> you reboot.

1. **Log in** (a browser opens; click authorize):

   ```powershell
   cloudflared tunnel login
   ```

2. **Create the tunnel** (`my-bridge` is a name, pick any, remember it):

   ```powershell
   cloudflared tunnel create my-bridge
   ```

3. **Point the domain at the tunnel** (replace `dsh.example.com` with your subdomain):

   ```powershell
   cloudflared tunnel route dns my-bridge dsh.example.com
   ```

4. **Write the config** `C:\Users\<you>\.cloudflared\bridge.yml` (the UUID and json
   filename come from step 2's output — copy them):

   ```yaml
   tunnel: <UUID from step 2>
   credentials-file: C:/Users/<you>/.cloudflared/<same UUID>.json
   ingress:
     - hostname: dsh.example.com
       service: http://127.0.0.1:3780
     - service: http_status:404
   ```

5. **Start the tunnel + tell the plugin**. Test manually first:

   ```powershell
   cloudflared tunnel --config "C:/Users/<you>/.cloudflared/bridge.yml" --no-autoupdate run my-bridge
   ```

   Seeing `Registered tunnel connection` means success. Then set the plugin config
   (`cordis.patch.yml` or Settings → ChatGPT page):

   ```yaml
   config:
     publicOrigin: 'https://dsh.example.com'
     autoStartTunnel: false        # the tunnel is already running manually
     tunnel:
       mode: named
       tunnelName: my-bridge
       configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
   ```

   ✅ **Verify**: open `https://dsh.example.com/dsh-with-chatgpt` in a browser; seeing
   `bridge is running` means done. Want it to start at logon? Tell the agent:
   "install cloudflared as a logon scheduled task".

---

#### Route B: no domain — zero config, works immediately

Nothing to buy, nothing to register. `/chatgpt setup` starts a quick tunnel
automatically and prints a `https://xxxx.trycloudflare.com/dsh-with-chatgpt/mcp`-style
URL on the spot.

- ✅ Zero config, works right after install
- ⚠️ The only catch: **the URL changes when DSH restarts** — update the connector URL
  in ChatGPT (and re-enter the pairing code, a 30-second chore)

No configuration changes needed; this route is the default. Jump straight to the
"Connect ChatGPT" three steps above.

> 💡 Run Route B first to validate the whole flow; upgrade to Route A whenever you want
> a fixed address — switching is just the few yaml lines above.

---

### Fixed domain (advanced reference)

The rationale behind Route A (equivalent to the steps above, for troubleshooting):
a quick tunnel URL changes on every restart, while a named tunnel CNAMEs a fixed
subdomain to your tunnel, making the URL permanent:

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
        autoStartTunnel: false   # an external supervisor owns the tunnel
        tunnel:
          mode: named
          tunnelName: my-bridge
          configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
```

## Differences from the original

Upstream (codex-with-chatgpt) ships a Node CLI plus a Codex Skill and drives the ChatGPT
side by typing `[C2C]` messages into the web UI. DSH has no browser-automation surface,
so this plugin replaces that half with two control-plane MCP tools:

| Upstream | Here |
|---|---|
| `c2c setup` / `c2c status` CLI | `/chatgpt` command + settings page + `c2c_setup` tool |
| Codex Skill file | `systemPrompt` section installed by the plugin |
| "Computer Use" types into ChatGPT | `control_submit` / `control_inbox` MCP tools |
| `c2c record` / `session --json` | `c2c_record`, `c2c_session` tools + JSONL journal |
| Desktop status screen | Settings → **ChatGPT** panel (React slot, DSH theme tokens) |

Same protocol, same message format, same security posture, same 13-rule boot prompt —
the ChatGPT half is unchanged and upstream docs still apply.

## Security

- The MCP endpoint always requires an OAuth bearer token — the tunnel makes it publicly
  reachable.
- The state API (`/api/*`) answers loopback only, and additionally refuses any request
  carrying tunnel headers, a non-loopback `Host`, or a cross-site `Origin` — a
  `cloudflared` request also arrives from a loopback socket, so the socket check alone
  would not be enough.
- Pairing codes are 8 symbols, 5-minute TTL, one-time, 5 attempts, rate limited per IP.
- Refresh-token replay revokes the whole token family.
- Path containment uses `realpathSync.native`, so NTFS junctions cannot escape the root.

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

## License

MIT, like the original.
