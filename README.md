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

### 固定域名（可选）

quick 隧道的地址每次重启都会变。想要稳定连接器 URL，一次性创建命名隧道：

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
