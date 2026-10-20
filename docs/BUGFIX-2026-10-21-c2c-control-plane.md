# C2C 控制面缺陷修复记录（2026-10-21）

## 摘要

| 项 | 内容 |
| --- | --- |
| 组件 | `dsh-with-chatgpt` v0.1.0（DSH ↔ ChatGPT 规划桥） |
| 缺陷数 | 3（1 个阻断级、2 个体验级） |
| 影响 | ChatGPT 无法回传任何 PLAN，C2C 循环**完全无法启动** |
| 修复文件 | `lib/c2c.js`、`lib/mcp.js`、`lib/entry.js`、`tests/mcp.test.js` |
| 回归 | `node --test 'tests/*.test.js'` → 132 通过 / 0 失败 |
| 真机验证 | 是。ChatGPT 侧 `control_submit` 由 `BAD_HEADER` 转为 `accepted: true`，PLAN 入库 |

---

## 缺陷 1（阻断级）：PLAN 一律被拒为 `BAD_HEADER`

### 现象

ChatGPT 每次调用 `control_submit` 都返回：

```json
{ "accepted": false, "reason": "BAD_HEADER" }
```

用户侧看到的是「已经规划完了，但 DSH 一直说没收到」。本地 `control.jsonl` 里只有 outbound 的 INIT，零 inbound 记录，C2C 卡在 `INIT` 状态无法前进。

### 根因

`lib/c2c.js` 的 `parseControlMessage()` 用**逐行正则**解析头部区，零容忍：

```js
for (; index < lines.length; index += 1) {
  const line = lines[index];
  if (line.trim() === '') { index += 1; break; }
  const match = /^([A-Z][A-Z0-9_]*):\s*(.*)$/.exec(line);
  if (!match) return { ok: false, reason: 'BAD_HEADER', bytes, line: index + 1 };
  headers[match[1]] = match[2].trim();
}
```

只要有一行不是严格的 `KEY: value` 就整条消息作废。而 ChatGPT 作为对话模型，写控制消息时**必然**会带上 Markdown 装饰，实测出现过以下全部变体：

| ChatGPT 实际写法 | 旧解析器结果 |
| --- | --- |
| `**STATE:** PLAN` | `BAD_HEADER` |
| `## STATE: PLAN` | `BAD_HEADER` |
| `STATE：PLAN`（全角冒号） | `BAD_HEADER` |
| `STATE: PLAN` 与 `TASK_ID:` 之间漏空行 | `BAD_HEADER` |
| 整条消息被 ``` 围栏包裹 | `MISSING_HEADER` |
| `[c2c]` 小写标记 | `MISSING_HEADER` |

也就是说：**协议要求的是「机器格式」，但对面是一台会排版的语言模型**。工具描述里只写了「`[C2C]` 开头，最多 1 KiB」，没有给出可照抄的报文骨架，于是模型只能凭记忆拼格式，每次都拼歪。

### 修复

1. **把逐行严格解析换成块式宽容解析**（`lib/c2c.js`）。新增 `SECTION_LINE` 正则，允许前导 `>`、`#`、`*`、`-`、反引号、空白，允许全角冒号 `：`，允许键后同行带值：

   ```js
   const SECTION_LINE = /^[\s>*#\-`]*([A-Z][A-Z0-9_]*)[\s*`]*[:：][\s*`]*(.*)$/;
   ```

   解析逻辑改为：一行只要「像键」就开新块，不像键的行归入上一块的续行。这样 `KEY:` 换行写值、`KEY: 值` 同行写、以及 `**KEY:**` 全部落到同一套路径上。

2. **首行标记归一化**。不再用 `raw.startsWith('[C2C]')`，改为对首行做正则匹配，容忍 `## [C2C]`、`**[C2C]**`、大小写：

   ```js
   const marker = /^\s*(?:[>#*\-`\s]*)\[c2c\]\s*$/i.test(firstLine);
   ```

3. **剥离 Markdown 围栏**。新增 `stripCodeFence()`，整条消息被 ``` 包裹时自动脱壳。

4. **头部键与正文键分流**。新增 `HEADER_KEYS = {STATE, TASK_ID, ITERATION}`，其余键一律当正文节；同名节重复出现时按换行拼接而不是覆盖（模型有时把 ACTIONS 分成两段写）。

5. **工具描述给出可照抄的骨架**（`lib/mcp.js`）。这是**根因侧的修复**——原来的描述只说了限制，没说格式。现在 `control_submit` 的描述里直接内嵌一段完整报文样例，并逐条列出每个状态必填的节名。

### 验证

```
plain              OK  PLAN
markdown-bold      OK  PLAN     (**STATE:** PLAN)
markdown-h2        OK  PLAN     (## STATE: PLAN)
fenced             OK  PLAN     (``` 围栏)
lowercase-marker   OK  PLAN     ([c2c])
fullwidth-colon    OK  PLAN     (STATE：PLAN)
inline-values      OK  PLAN     (GOAL: a 同行)
```

真机：ChatGPT 重新提交后返回 `accepted: true`，`control.jsonl` 出现第 3 条 `direction=in / state=PLAN`，999 字节，含 GOAL / ACTIONS / TESTS / SUCCESS_CRITERIA 四节。

---

## 缺陷 2（体验级）：1 KiB 上限过紧，规划被压缩成电报体

### 现象

ChatGPT 为了让 PLAN 塞进 1024 字节，把 6 条线程的计划压成 `A/P0：A1快照回滚→A2纹理容错→A3全灭判负` 这种缩写。信息密度是够了，但**文件路径、测试步骤、验收标准全被挤掉了**，DSH 拿到后仍要自己反推。

### 根因

上限散落在**三个互不联动的常量**里，改一处不生效：

| 位置 | 原值 | 作用 |
| --- | --- | --- |
| `lib/c2c.js` `MAX_CONTROL_BYTES` | 1024 | 控制面解析器自身的硬闸 |
| `lib/mcp.js` `DEFAULT_LIMITS.controlMessageBytes` | 1024 | MCP 层在交给控制面**之前**就拦掉 |
| `lib/entry.js` `DEFAULTS.limits` | 无此键 | 配置归一化时被丢弃，用户改配置也传不下去 |

第三处是隐藏 bug：`normalizeConfig()` 用白名单逐键拷贝 `limits`，`controlMessageBytes` 不在名单里，所以即使配置里写了也会被静默丢弃。

### 修复

- 三处统一为 **16 KiB**（`MAX_CONTROL_BYTES`、`DEFAULT_LIMITS.controlMessageBytes`、`DEFAULTS.limits.controlMessageBytes`）。
- `normalizeConfig()` 的 limits 白名单补上 `controlMessageBytes`，配置可覆盖。
- 三处常量都加了交叉引用注释，说明**为什么必须同值**（MCP 层先拦，值小了会静默回退到旧上限）。

为什么是 16 KiB 而不是无限：控制通道承载的是**意图**不是**内容**——一个真实的六线程计划，每线程带文件路径和验收标准，实测约 3~6 KiB；16 KiB 留了两倍余量，同时远低于任何文件正文，不会让通道退化成「贴日志」的通道。上限是安全阀，不是预算。

### 验证

新增回归用例：构造 150 行 ACTIONS 的多 KB PLAN，断言 `accepted`；再构造 20 KiB 报文，断言被拒且**未到达控制面**（`submit` 调用计数不变）。

---

## 缺陷 3（体验级）：`c2c_setup` 的 `connect` / `setup` 动作返回 schema 错误

### 现象

```
Error: tool "c2c_setup" returned invalid output:
"value.tunnel" is not a declared property (additionalProperties: false)
```

`setup` 动作还额外报 `value.publicOrigin`。

### 根因

`c2c_setup` 的返回值里带了 `tunnel` / `publicOrigin` 字段，但该工具在 `TOOL_SPECS` 里声明的 output schema 是 `additionalProperties: false` 且没有声明这两个属性。属于**返回体与自身 schema 不一致**。

### 状态

**未修复**（本次只记录）。影响面有限：`status` 动作正常，隧道可以手工用 cloudflared 拉起，配对码可以用 `action=pair` 单独取。修它需要改 output schema 声明，属于独立改动，不阻塞 C2C 主循环，因此留待后续。

---

## 附：本次顺带确认的两条运维事实

1. **公网隧道不能由 `c2c_setup` 拉起**（受缺陷 3 影响），必须手工执行：
   ```
   cd '/c/Program Files (x86)/cloudflared' && ./cloudflared.exe tunnel \
     --config 'C:\Users\压音\.cloudflared\c2c-bridge.yml' run
   ```
   且该进程必须挂在**长驻的后台 job** 上——`nohup &`、`cmd /c start /b`、`disown` 在本机全部无法让进程存活。

2. **配对码只能由用户手工输入**到 ChatGPT 连接器授权页，DSH 侧无法代劳；有效期 5 分钟。

---

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `lib/c2c.js` | 新增 `stripCodeFence` / `HEADER_KEYS` / `SECTION_LINE`；重写 `parseControlMessage` 头部与正文解析；`MAX_CONTROL_BYTES` 1024 → 16 KiB；启动提示词第 5 条同步 |
| `lib/mcp.js` | `control_submit` 描述内嵌报文骨架与各状态必填节；`DEFAULT_LIMITS.controlMessageBytes` 1024 → 16 KiB |
| `lib/entry.js` | `DEFAULTS.limits` 与 `normalizeConfig()` 白名单补 `controlMessageBytes` |
| `tests/mcp.test.js` | 更新契约断言；新增多 KB 报文接受、超限拒绝、Markdown 变体解析三类回归 |
