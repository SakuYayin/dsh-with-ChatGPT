# DSH with ChatGPT

**ChatGPT 负责思考，DSH 负责干活。**

[codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) 的 DSH 插件版：
把 ChatGPT 网页版变成你本地工作区的「规划 + 审查大脑」，DSH Agent 继续保持执行权 ——
改代码、跑命令、跑测试都由它做，ChatGPT 只读不写。

无需 API Key、无需反向代理。ChatGPT 通过一个**只读 MCP 连接器**（cloudflared 官方隧道）
访问你的工作区，用的就是你已有的 ChatGPT 订阅。

- **工作区即边界**：所有路径都被限制在配置的根目录内，junction/软链也逃不出去。
- **构造上只读**：写 / 删 / shell / commit 类工具根本不存在，不是「禁用」而是「没有」。
- **OAuth 2.1**（PKCE S256、动态客户端注册、刷新令牌轮换 + 家族吊销）加一次性配对码
  —— 用户唯一需要输入的凭证。
- **控制消息永远小于 1 KB**：只传意图，不传内容。没有 diff、没有日志、没有文件正文。

## 一键安装（Agent 指令）

装好 DSH 后，对 Agent 说这一句话即可完成从克隆到启用的全部步骤：

```text
用 ChatGPT 规划前先装插件：克隆 https://github.com/SakuYayin/dsh-with-ChatGPT 到本地，
用 plugin_manager 的 install_bundle 安装该目录，然后运行 /chatgpt setup，
把打印出来的连接器 URL 和配对码告诉我。
```

或者分步执行（等价）：

```powershell
git clone https://github.com/SakuYayin/dsh-with-ChatGPT.git
dsh plugin install .\dsh-with-ChatGPT
```

装完后在 DSH 会话里说 `/chatgpt setup`（或让 Agent 调 `c2c_setup` 工具的 setup 动作），
它会：启动隧道 → 生成配对码 → 打印下面的自检清单：

```text
DSH with ChatGPT
✓ 当前项目已识别（my-project）
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 配对码已生成
Ready.
```

## 连接 ChatGPT（一次性，约 2 分钟）

1. ChatGPT → **Settings → Connectors → Create**，描述随便填，URL 填 `/chatgpt setup`
   打印的连接器地址，Authentication 选 **OAuth**
   （可能需要先在 `chatgpt.com/#settings/Security` 打开 Developer mode）。
2. 打开该连接器，在配对页输入上面打印的 **8 位配对码**（5 分钟有效，一次性）。
3. 把 `c2c_setup` 一并打印的 **Project instructions** 粘贴到 ChatGPT Project 设置里。
   注意：只贴连接器**名称**，不要把连接器 URL 放进 Project instructions。

之后在 DSH 里说 **「用 ChatGPT 规划 <目标>」** 即可，Agent 会调 `c2c_start` 启动循环：

```text
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

ChatGPT 通过 `control_submit` 发回 `PLAN`/`DONE`/`BLOCKED`/`HANDOFF`，DSH Agent 用
`c2c_inbox` 取出并继续。迭代预算默认 12 轮，用完会暂停并询问。

## 工具一览

插件注册两组工具。

**Agent 工具（DSH 侧，编排循环）**

| 工具 | 用途 |
|---|---|
| `c2c_start` | 启动循环：生成任务 id + INIT 消息 + boot prompt |
| `c2c_inbox` | 取回 ChatGPT 的 PLAN/DONE/BLOCKED/HANDOFF，推进检查点 |
| `c2c_record` | 记录本轮执行（改动文件、测试结果、脱敏输出） |
| `c2c_executed` | 生成 EXECUTED 控制消息（只含文件数与测试行） |
| `c2c_handoff` | ChatGPT 会话丢失时用 1 KB 简报恢复 |
| `c2c_session` | 读取 / 设置 / 清除本地检查点 |
| `c2c_setup` | 状态、隧道、配对码、Project instructions |

**MCP 工具（ChatGPT 侧，只读）**

`workspace_info`、`list_directory`、`read_file`、`search_workspace`、`git_status`、
`git_diff`、`test_status`、`execution_summary`、`execution_output`、`read_image`，
外加控制面的 `control_submit` / `control_inbox`。

敏感文件（`.env*`、密钥、SSH 材料、凭据）默认拒绝读取 —— `.env.example` 保持可读。
`.c2cignore` 可加项目级规则。命令输出在本地脱敏后才对 ChatGPT 可见：私钥和 token
整体扣留，受限条目在列表中出现但无正文。

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 不卸载的前提下关闭插件 |
| `workspace` | `''` | 工作区根目录；空 = 会话工作目录 |
| `prefix` | `/dsh-with-chatgpt` | HTTP 挂载点，保持相对路径以便端口变化后端点不变 |
| `connectorName` | `''` | ChatGPT 连接器标签；空 = `DSH with ChatGPT (<workspace>)` |
| `maxIterations` | `12` | 软性循环预算，用完暂停询问用户 |
| `autoStartTunnel` | `false` | 随桥接一起启动公网隧道 |
| `tunnel` | `quick` | `quick`（`*.trycloudflare.com`，每次重启会变）或 `named` |
| `cloudflaredPath` | `''` | 显式二进制路径 |
| `publicOrigin` | `''` | 隧道由外部托管时的固定公网地址（如 `https://dsh.example.com`），桥接直接上报该 URL |
| `tunnel.token` / `tunnel.hostname` / `tunnel.tunnelName` / `tunnel.configPath` | `''` | 命名隧道选项：给 token（远程托管 ingress）**或**本地配置文件 + 隧道名（`--config <path> … run <name>`）；hostname 决定上报的 URL |
| `limits` | 见下 | `maxFileBytes` 128 KiB、`maxDiffBytes` 96 KiB、`maxOutputBytes` 64 KiB、`maxOutputLines` 600、`maxImageBytes` 4 MiB |

### 选隧道：只问自己一个问题

> **「我有自己的域名吗？」**

```text
        ┌─ 有域名（如 yayin.bond）？ ──→ 走【路线 A】固定域名，一次配置永久用
        │
        └─ 没有域名？ ────────────────→ 走【路线 B】quick 隧道，0 配置直接用
```

---

#### 路线 A：有域名 —— 5 步，一次配置永久用

需要的材料：一个 Cloudflare 托管的域名（免费计划即可）、装好的 `cloudflared`。

> 💡 提示：全程只需做一次。之后无论电脑重启多少次，连接器 URL 永远不变。

1. **登录**（会自动开浏览器，点一下授权）：

   ```powershell
   cloudflared tunnel login
   ```

2. **建隧道**（`my-bridge` 是名字，随便起，记住它）：

   ```powershell
   cloudflared tunnel create my-bridge
   ```

3. **把域名指到隧道**（把 `dsh.你的域名.com` 换成你想要的子域名）：

   ```powershell
   cloudflared tunnel route dns my-bridge dsh.你的域名.com
   ```

4. **写配置文件** `C:\Users\<你的用户名>\.cloudflared\bridge.yml`（UUID 和 json 文件名
   在第 2 步的输出里，直接复制）：

   ```yaml
   tunnel: <第2步输出的UUID>
   credentials-file: C:/Users/<你的用户名>/.cloudflared/<同一个UUID>.json
   ingress:
     - hostname: dsh.你的域名.com
       service: http://127.0.0.1:3780
     - service: http_status:404
   ```

5. **启动隧道 + 告诉插件**。先手动测试：

   ```powershell
   cloudflared tunnel --config "C:/Users/<你的用户名>/.cloudflared/bridge.yml" --no-autoupdate run my-bridge
   ```

   看到 `Registered tunnel connection` 就成功了。然后改插件配置
   （`cordis.patch.yml` 或 Settings → ChatGPT 页）：

   ```yaml
   config:
     publicOrigin: 'https://dsh.你的域名.com'
     autoStartTunnel: false        # 隧道刚才已手动跑起来了
     tunnel:
       mode: named
       tunnelName: my-bridge
       configPath: 'C:/Users/<你的用户名>/.cloudflared/bridge.yml'
   ```

   ✅ **验收**：浏览器打开 `https://dsh.你的域名.com/dsh-with-chatgpt`，看到
   `bridge is running` 就成了。想开机自启？对 Agent 说：
   「把 cloudflared 装成登录自启的计划任务」。

---

#### 路线 B：没有域名 —— 0 配置，直接用

什么都不用买、不用注册。`/chatgpt setup` 会自动启动 quick 隧道，当场给你一个
`https://xxxx.trycloudflare.com/dsh-with-chatgpt/mcp` 这样的地址。

- ✅ 零配置，装完即用
- ⚠️ 唯一缺点：**DSH 重启后地址会变**，需要把 ChatGPT 连接器里的 URL 换成新的
  （配对码重输一次，30 秒的事）

配置什么都不用改，默认就是这条路线。直接跳到上面的「连接 ChatGPT」三步即可。

> 💡 先用路线 B 跑通全流程，哪天想要固定地址了再升级到路线 A —— 两条路线随时可切，
> 插件配置就是上面那几行 yaml 的差别。

---

### 固定域名（进阶参考）

上面路线 A 的原理性说明（与步骤等价，供排查问题用）：quick 隧道的地址每次重启都会变，
命名隧道把一个固定子域名 CNAME 到你的隧道，地址就永久不变：

```powershell
cloudflared tunnel login
cloudflared tunnel create my-bridge
cloudflared tunnel route dns my-bridge dsh.example.com
```

写 `~/.cloudflared/bridge.yml`：

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:/Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:3780
  - service: http_status:404
```

把它跑起来（比如登录时启动的计划任务），然后在 `cordis.patch.yml` 里配置：

```yaml
- insert:
    - id: dsh-with-chatgpt
      name: dsh-with-chatgpt
      config:
        publicOrigin: 'https://dsh.example.com'
        autoStartTunnel: false   # 隧道由外部守护进程负责
        tunnel:
          mode: named
          tunnelName: my-bridge
          configPath: 'C:/Users/<you>/.cloudflared/bridge.yml'
```

## 与原版的差异

原项目（codex-with-chatgpt）是 Node CLI + Codex Skill，靠「计算机操作」往 ChatGPT
网页里打 `[C2C]` 消息。DSH 没有浏览器自动化层，所以本插件把那一半换成了两个控制面
MCP 工具：

| 原版 | 本插件 |
|---|---|
| `c2c setup` / `c2c status` CLI | `/chatgpt` 命令 + 设置页 + `c2c_setup` 工具 |
| Codex Skill 文件 | 插件安装的 `systemPrompt` 分区 |
| 「Computer Use」往 ChatGPT 打字 | `control_submit` / `control_inbox` MCP 工具 |
| `c2c record` / `session --json` | `c2c_record`、`c2c_session` 工具 + JSONL 日志 |
| 桌面状态屏 | Settings → **ChatGPT** 面板（React slot，DSH 主题 token） |

协议、消息格式、安全姿态、13 条 boot prompt 完全一致 —— ChatGPT 那一半无需改动，
原版文档照样适用。

## 安全

- MCP 端点始终要求 OAuth bearer token —— 因为隧道让它公网可达。
- 状态 API（`/api/*`）只回答回环请求，且额外拒绝任何带隧道头、非回环 `Host` 或跨站
  `Origin` 的请求 —— `cloudflared` 的请求同样来自回环 socket，仅查 socket 不够。
- 配对码 8 位符号、5 分钟 TTL、一次性、5 次尝试、按 IP 限速。
- 刷新令牌重放会吊销整个令牌家族。
- 路径围栏使用 `realpathSync.native`，NTFS junction 无法逃逸。

## 测试

```powershell
node --test --experimental-test-isolation=none tests/auth.test.js
node --test --experimental-test-isolation=none tests/mcp.test.js
node --test --experimental-test-isolation=none tests/tunnel.test.js
node --test --experimental-test-isolation=none tests/workspace.test.js
node --test --experimental-test-isolation=none tests/http.test.js
```

`--experimental-test-isolation=none` 只在禁止管道子进程 stdio 的沙箱里需要；普通
shell 直接 `node --test` 即可。

## 许可

MIT，与原版一致。
