# ACP 链路真实核心验证报告

**验证日期**：2026-07-29
**验证脚本**：`app/scripts/verify-acp.mjs`
**被验证代码**：`app/src/main/acp/connection.ts`、`app/src/main/acp/normalize.ts`

---

## 一、结论（先说结果）

**宿主的 ACP 链路可以驱动真实核心** —— 协议层已被真实核心端到端证实，但**推理链路未被证实**。

| 环节 | 状态 | 证据 |
| --- | --- | --- |
| 进程 spawn + stdio 管道 | 通过 | 真实核心启动并进入 ACP 模式 |
| `initialize` 握手与能力协商 | 通过 | 协商到 protocolVersion 1，收到完整 agentCapabilities |
| `session/new` | **被拒（缺凭据）** | 核心返回 `-32000`，错误被完整捕获 |
| `session/prompt` + 流式事件 | **未验证** | 无凭据，未能进入此步 |
| 认证错误捕获与归一 | 通过 | `-32000` + 原文消息完整保留 |
| 干净关闭 | **不通过** | 核心无视 SIGTERM，需 SIGKILL |

按任务约定，**没有 API Key 时验证目标降级为「握手 + session/new + 认证错误归一」，此目标已达成**。

同时发现 **3 个宿主侧的真实问题**，其中 1 个是会泄漏进程的实际 Bug，详见第六节。

---

## 二、验证方法与可信度约束

脚本不依赖 Electron，只用 `@agentclientprotocol/sdk` + `node:child_process`。它**复刻**了
`connection.ts` 的 Node/Web 流桥接、客户端能力声明（不声明 `fs`／`terminal`）与权限应答逻辑，
因此这里的结果对宿主是有效的。

为保证结论不被"其实偷偷用了现有凭据"污染，脚本做了两层隔离：

1. **环境变量白名单**（不是黑名单）。只透传 `PATH / LANG / LC_ALL / TERM / TMPDIR / USER /
   SHELL / NODE_OPTIONS / 代理变量`。黑名单会漏掉想不到的 key 名，白名单不会。
2. **HOME 隔离**。`HOME`、`XDG_*` 全部重定向到 `app/.verify/home`。核心的 OAuth 登录态存在真实
   HOME 下，不隔离的话「未认证」的验证会被操作者已登录的账号伪装成「已认证」，整个结论作废。

本次运行实际透传的变量：
`HOME, HTTPS_PROXY, HTTP_PROXY, NO_PROXY, PATH, SHELL, TMPDIR, USER, XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME`
被判定为疑似凭据而屏蔽的变量：**（无）** —— 该机器 shell 环境里本来就没有 API Key 类变量。

---

## 三、实际安装的核心

| 核心 | 版本 | 安装耗时 | 结果 |
| --- | --- | --- | --- |
| `@google/gemini-cli`（`gemini --acp`） | **0.53.0** | 约 1 分钟 | **安装成功，已用于验证** |
| `@agentclientprotocol/codex-acp` | 1.1.7（包本体已到） | **> 50 分钟仍未完成，最终放弃** | **未能用于验证** |

### codex-acp 未能完成的原因（如实记录）

优先级最高的 `@agentclientprotocol/codex-acp` 首先被尝试。包本体 1.1.7 很快装好，但它依赖
`@openai/codex` → `@openai/codex-darwin-arm64`，这是一个 Rust 编译的大体积二进制。在国内网络下
下载超过 50 分钟仍未结束（`.verify/node_modules` 缓慢爬到 55 MB 后基本停滞，
`node_modules/.bin/codex-acp` 始终未生成，`npm install` 进程一直未退出也未报错），
因此改用优先级第三的 Gemini CLI 完成验证。同期在同一台机器、同一网络下安装
`@google/gemini-cli` 只用了约 1 分钟，可见瓶颈在该二进制的下载源而非本地网络整体不可用。

这本身是一条对产品有意义的结论：**codex 系核心的首次安装体验在国内网络下不可接受**，
「装核心」这一步需要镜像源或断点续传，不能直接暴露 `npm install` 给用户。

> `@zed-industries/claude-code-acp` 未尝试：它已 deprecated，且其继任者
> `@agentclientprotocol/claude-agent-acp` 同样需要凭据，对本次「无凭据降级验证」不会带来新信息。

---

## 四、握手结果（原文）

### 请求（宿主 → 核心）

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"tietiezhi-verify-acp","version":"0.1.0"}}}
```

### 响应（核心 → 宿主）

协商到的 **`protocolVersion`: 1**（与宿主 SDK 的 `PROTOCOL_VERSION` 一致，无降级）。

`agentCapabilities` 原文：

```json
{
  "loadSession": true,
  "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true }
}
```

`agentInfo` 原文：

```json
{ "name": "gemini-cli", "title": "Gemini CLI", "version": "0.53.0" }
```

`authMethods` 原文：

```json
[
  { "id": "oauth-personal", "name": "Log in with Google", "description": "Log in with your Google account" },
  { "id": "gemini-api-key", "name": "Gemini API key", "description": "Use an API key with Gemini Developer API",
    "_meta": { "api-key": { "provider": "google" } } },
  { "id": "vertex-ai", "name": "Vertex AI", "description": "Use an API key with Vertex AI GenAI API" },
  { "id": "gateway", "name": "AI API Gateway", "description": "Use a custom AI API Gateway",
    "_meta": { "gateway": { "protocol": "google", "restartRequired": "false" } } }
]
```

握手耗时 2815 ms。

---

## 五、失败点（原样贴出）

### `session/new` 被拒

线上原始报文：

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/Users/tietiezhi/Project/Tietiezhi/app","mcpServers":[]}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Gemini API key is missing or not configured."}}
```

宿主侧捕获到的结构：

```json
{
  "created": false,
  "error": { "type": "RequestError", "code": -32000, "message": "Gemini API key is missing or not configured.", "data": null },
  "recognisedAsAuthError": true
}
```

**这是预期内的失败，且是一次成功的验证**：核心用 ACP 规定的 `-32000`（auth_required）拒绝，
SDK 把它还原成了带 `code` 的 `RequestError`，消息原文一字不失地到达宿主。说明连接、协商、
错误传播路径全部是通的。

### 关闭不干净（非预期，见第六节 6.1）

```json
{ "clean": false, "exited": true, "code": null, "signal": "SIGKILL", "ms": 10019,
  "error": { "type": "StepTimeoutError", "message": "步骤「core exit」超过 10000ms 未返回，判定为超时。" } }
```

---

## 六、发现的问题

### 6.1 【真实 Bug，会泄漏进程】`close()` 只发 SIGTERM 且不等进程真死

`connection.ts` 的 `close()`：

```ts
if (!closed) {
  child.kill();                       // 默认 SIGTERM
  markClosed({ status: "stopped" });  // 立刻 resolve closedPromise
}
await closedPromise;                  // 因此立即返回
```

`markClosed` 在 `child.kill()` 之后**同步**调用，`closedPromise` 随即 resolve，所以
`await handle.close()` 会在子进程仍然活着的时候就返回，而且**永远不会升级到 SIGKILL**。

独立复现实验（脱离本脚本，直接 spawn）：

```
sending SIGTERM
STILL ALIVE 8s after SIGTERM -> core ignores SIGTERM
EXITED code=null signal=SIGKILL after 9512ms
```

**`gemini --acp` 完全无视 SIGTERM，只有 SIGKILL 能杀掉它。**

后果：用户每停止一次 Gemini 核心，就残留一个常驻进程；退出应用时同样残留。多开几次核心，
机器上会堆积一批孤儿 `gemini` 进程。

建议：`close()` 改为「SIGTERM → 等待宽限期（本脚本用 10s，实际可缩短到 3~5s）→ SIGKILL」，
并且 `closedPromise` 应当在**进程 `exit` 事件**之后才 resolve，而不是发完信号就 resolve。

### 6.2 normalize.ts 的「前向兼容」注释与实际行为不符

`normalize.ts` 的 `default` 分支注释称，它能兜住「比我们编译时更新的 ACP 版本引入的变体」，
使其不会中断一轮对话。**实测这个保护不会生效**，因为它根本到不了 normalize。

用受控 stub 核心（非 Gemini，见下方说明）发送一个未知变体
`{"sessionUpdate":"brand_new_future_variant", ...}`，SDK 在把通知交给 `Client.sessionUpdate`
**之前**就用 zod 校验拒绝了它，直接回 `-32602 Invalid params`，normalize 完全没被调用，
事件计数也没有增加。

也就是说：
- `default` 分支实际只能接到**SDK 已知、但宿主没建模**的 6 个变体；
- 真正来自未来 ACP 版本的未知变体，会在 SDK 层被拒，宿主既拿不到也无法降级处理。

这不一定是 Bug（拒绝未知输入也是一种合理策略），但**注释所承诺的能力是不存在的**，
应当修正注释，或在 SDK 层面改用宽松校验。

> 说明：这一条来自受控 stub，不是 Gemini 的真实输出。因为无凭据跑不到 `session/prompt`，
> 未知变体只能靠构造复现。stub 仅用于探测 SDK 校验行为，不参与第一节的结论。

### 6.3 `mcpCapabilities` 未被 `CoreCapabilities` 建模

真实核心返回了 `"mcpCapabilities": { "http": true, "sse": true }`，而 `parseCapabilities()`
只提取 `loadSession` 和 `promptCapabilities.*`。该字段仍保留在 `raw` 里没有丢失，但宿主无法
在不解析 `raw` 的情况下知道某个核心支不支持 HTTP/SSE 型 MCP server —— 而 `session/new` 的
`mcpServers` 参数正需要这个信息来决定投影哪种格式。建议把它提升为一等字段。

---

## 七、`session/update` 事件覆盖情况

**本次真实核心实际收到的 `session/update` 事件：0 条**（因为 `session/new` 就被拒了，
根本没有 session 可以产生事件）。所以「真实事件 ↔ normalize 分支」的逐条比对**本次无法完成**，
这是本次验证最大的缺口，必须如实说明。

脚本已内置该比对能力（从 `normalize.ts` 源码正则提取 `case` 标签，与实际收到的变体求差集），
一旦拿到凭据，重跑即可自动产出比对结果。

当前可做的是**静态比对**（SDK schema 已知变体 vs normalize 分支）：

| SDK 已知变体（13） | normalize.ts 是否覆盖 |
| --- | --- |
| `agent_message_chunk` | 覆盖 → `message-delta` |
| `agent_thought_chunk` | 覆盖 → `thought-delta` |
| `tool_call` | 覆盖 → `tool-call` |
| `tool_call_update` | 覆盖 → `tool-call-update` |
| `plan` | 覆盖 → `plan` |
| `plan_update` | 覆盖 → `plan` |
| `plan_removed` | 覆盖 → `plan` |
| `user_message_chunk` | **未覆盖**（落入 default） |
| `available_commands_update` | **未覆盖** |
| `current_mode_update` | **未覆盖** |
| `config_option_update` | **未覆盖** |
| `session_info_update` | **未覆盖** |
| `usage_update` | **未覆盖** |

未覆盖的 6 个都是宿主**有意**不建模的（`normalize.ts` 注释已写明），会走 `onDiagnostic`
记录而不产生渲染事件，不会中断对话。用 stub 发送 `current_mode_update` 验证过这条路径确实
按预期走 default 分支，未抛异常。

需要留意的是 `usage_update`（token 用量）与 `available_commands_update`（斜杠命令），
这两个是用户可感知的功能，长期缺失会被察觉。

---

## 八、复现方法

```bash
# 1) 装一个真实核心到 .verify（已在根 .gitignore 忽略）
mkdir -p app/.verify/alt && cd app/.verify/alt
npm install @google/gemini-cli

# 2) 跑验证
cd /Users/tietiezhi/Project/Tietiezhi/app
node scripts/verify-acp.mjs \
  --core gemini \
  --command ./.verify/alt/node_modules/.bin/gemini \
  --cwd "$PWD"
```

退出码：0 = 通过或降级通过，1 = 失败，2 = 参数错误。

每次运行会写出两个文件：
- `app/.verify/report-<core>-<时间戳>.json` —— 结构化报告（含每个变体的一条原始样本）
- `app/.verify/wire-<core>-<时间戳>.ndjson` —— **逐行原始 JSON-RPC 报文**，收发双向

原始报文是在字节流层面 tap 的，早于 SDK 的任何解析与校验，因此本报告引用的报文就是真正
过管道的内容。

其它可用核心：`--core codex-acp` / `--core claude-agent-acp` / `--core claude-code-acp`；
或用 `--command` + `--arg=--foo` 指向任意 ACP 可执行文件。

---

## 九、待办：拿到凭据后必须补做的验证

以下问题本次**没有**得到回答，不要当成已验证：

1. `session/prompt` 能否跑通，`stopReason` 是什么。
2. 真实的 `agent_message_chunk` / `agent_thought_chunk` 内容块结构，`contentBlockToText()`
   的 5 个分支是否都对得上真实输出。
3. 真实的 `tool_call` / `tool_call_update` 是否真的会省略 `status`（`UNCHANGED_STATUS`
   这条设计假设完全未经验证）。
4. `session/request_permission` 的真实触发时机与 `options[].kind` 取值。
5. 核心是否会在我们未声明 `fs`/`terminal` 能力的情况下仍然调用它们，以及它收到
   `-32601` 后是优雅降级还是直接失败。**这条对「宿主不代理 fs/terminal」这个核心架构决策
   是决定性的，目前完全没有证据。**
