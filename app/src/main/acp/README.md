# `src/main/acp` — ACP client

铁铁汁是 **host / client**，每个核心（Claude Code、Codex、Gemini CLI、pi、自家 Rust 核心）
是 **agent**。本目录用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 通过子进程 stdio
说 ACP，把各核心的差异归一成 `@shared/contracts` 里的类型交给渲染层。

```
core-launcher → ChildProcess ─┐
                              ├─ connectAcpAgent()  一个核心一条连接
                              │      └─ Client 回调（requestPermission / sessionUpdate）
                              │
AcpSessionManager ────────────┴─ 多核心 × 多会话，事件按 sessionId 分流
       │
       ├─ emit("stream",     CoreStreamEvent)
       ├─ emit("permission", CorePermissionRequest)  →  resolvePermission(requestId, decision)
       ├─ emit("run-state",  coreId, CoreRunState)
       └─ emit("diagnostic", message, detail)
```

## 我们声明了哪些 client capability

`initialize` 里发出的 `ClientCapabilities`：

| capability | 我们的取值 | 说明 |
| --- | --- | --- |
| `fs.readTextFile` | `false` | 见下 |
| `fs.writeTextFile` | `false` | 见下 |
| `terminal` | `false` | 见下 |
| `session.*` | 不声明 | 不需要客户端侧的会话扩展 |
| `plan`（unstable） | 不声明 | 不声明则核心只发完整 `plan`，不发增量 patch |
| `elicitation`（unstable） | 不声明 | 统一审批 UI 目前只覆盖 `session/request_permission` |
| `auth.terminal`（unstable） | `false` | 由 SDK 从 `terminal: false` 自动派生，我们不额外设置 |

必须实现、且我们确实实现的 client 方法只有两个：

- `session/request_permission` — 归一成 `CorePermissionRequest`，交给统一审批 UI
- `session/update` — 归一成 `CoreStreamEvent[]`

## 为什么不声明 fs / terminal

外部核心跑在它们自己的内核里：Claude Code 有自己的文件读写和 Bash 工具，Codex 有自己的沙箱，
Gemini CLI 同理。ACP 的 `fs/*` 与 `terminal/*` 是给「编辑器托管 agent」这种形态准备的——
由客户端提供带未保存缓冲区的文件视图和终端。铁铁汁不是编辑器：

1. **不重复实现**。我们代理一遍只会得到一个更差的文件系统（没有缓冲区、没有 LSP 上下文），
   核心自己那套反而被绕过。
2. **不制造两套权限模型**。核心内部已有自己的路径/命令白名单；我们再插一层，
   出问题时用户无法判断到底是谁拦下的。
3. **审批仍然统一**。不接管执行，不等于不接管**决策**——`session/request_permission`
   由我们渲染，所以无论哪个核心发起，用户看到的都是同一套审批界面。

`connection.ts` 里仍然实现了 `readTextFile` / `writeTextFile` / `createTerminal` /
`terminalOutput` / `releaseTerminal` / `waitForTerminalExit` / `killTerminal`，
但它们一律抛出 JSON-RPC `-32601`，错误信息里写明「未声明该能力」。这样，
一个无视 capability 协商硬调这些方法的核心会拿到明确的协议错误，而不是超时或静默挂起。

## 事件归一化映射表

`normalize.ts` 的 `normalizeSessionUpdate(notification, onUnhandled?)`
把一条 `session/update` 映射成 0..n 条 `CoreStreamEvent`：

| ACP `sessionUpdate` | `CoreStreamEvent.kind` | 备注 |
| --- | --- | --- |
| `agent_message_chunk` | `message-delta` | `content` 经 `contentBlockToText` 拍平成文本 |
| `agent_thought_chunk` | `thought-delta` | 同上 |
| `tool_call` | `tool-call` | `status` 缺省时补 `"pending"`；`raw` 保留整条 update |
| `tool_call_update` | `tool-call-update` | `status` 缺省时补 `"unchanged"`（表示本次没改动状态） |
| `plan` | `plan` | `raw` 为完整计划 |
| `plan_update` | `plan` | 未声明 `plan` 能力时核心不应发；收到也不丢，`raw` 带 `sessionUpdate` 判别字段 |
| `plan_removed` | `plan` | 同上 |
| `user_message_chunk` | *(无)* | 是我们自己 prompt 的回显（`session/load` 重放时才出现），走 `onUnhandled` |
| `available_commands_update` | *(无)* | 斜杠命令列表，暂未建模，走 `onUnhandled` |
| `current_mode_update` | *(无)* | 会话模式，暂未建模，走 `onUnhandled` |
| `config_option_update` | *(无)* | 会话配置项，暂未建模，走 `onUnhandled` |
| `session_info_update` | *(无)* | 标题等元信息，暂未建模，走 `onUnhandled` |
| `usage_update` | *(无)* | token 用量，暂未建模，走 `onUnhandled` |
| 其它 / 未知 | *(无)* | 走 `onUnhandled`，**不抛错**（见下） |

关于「未知 variant」：SDK 会先用 zod 校验 `session/update` 的 params，
完全不认识的 `sessionUpdate` 值在到达我们的 `sessionUpdate` 回调之前就被 SDK 丢掉了
（SDK 自己打一条日志，通知不会中断本轮）。`normalizeSessionUpdate` 的 `default` 分支
是第二道防线：SDK 认识但我们没建模的 variant 走到这里，将来 SDK 放宽校验时也不会炸。

不由 `session/update` 产生、但同属 `CoreStreamEvent` 的两条：

| 事件 | 产生位置 |
| --- | --- |
| `turn-ended` | `AcpSessionManager.prompt()` 拿到 `session/prompt` 的 `stopReason` 后发出 |
| `error` | prompt 抛错、或核心进程死亡时，为该核心下每个存活会话各发一条 |

`ContentBlock` 拍平规则（`contentBlockToText`）：

| block.type | 文本 |
| --- | --- |
| `text` | `block.text` |
| `image` | `[image <mimeType>]` |
| `audio` | `[audio <mimeType>]` |
| `resource_link` | `[<name>](<uri>)` |
| `resource` | 内嵌文本资源取 `text`，二进制取 `[resource <uri>]` |

## 生命周期与错误

- `initialize` 失败 → 上报 `CoreRunState.crashed`，kill 子进程，`connectAcpAgent` 抛错。
- 子进程 `exit` / `error`，或 stdout 关闭（ACP 流结束）→ 上报 `crashed`，
  message 里带上 stderr 尾部（最多 8 KiB），便于定位「核心装坏了」这类问题。
- 核心死亡时，所有还没回答的审批请求自动以 `cancelled` 结束，不会把核心卡死；
  `AcpSessionManager` 同时为该核心的每个会话发一条 `error` 事件并清掉会话表
  （会话状态活在核心进程里，进程没了句柄就失效了）。
- `cancel(sessionId)` 先发 `session/cancel`，再把该会话所有挂起的审批以 `cancelled` 回复——
  ACP 规定客户端取消一轮时必须这么做，否则核心会一直等审批结果。

## 并发

一条连接服务一个核心的全部会话。所有事件都带 `sessionId`（直接来自 notification），
所以多个会话同时流式不会串台。单个会话同一时刻只允许一轮 `session/prompt`，
重复调用 `prompt()` 会直接抛错而不是排队——排队会让 UI 上的「发送」看起来成功了但其实没开始。

## 集成

```ts
import { AcpSessionManager } from "./acp/index.js";

const acp = new AcpSessionManager({
  spawnCore: (coreId) => launcher.spawn(coreId),   // 由 core-launcher 提供
  clientInfo: { name: "tietiezhi", version: app.getVersion() },
  mcpServers: (coreId, cwd) => config.mcpServersFor(coreId, cwd),
});

acp.on("stream", (event) => bridge.emitToRenderer(event));
acp.on("permission", (request) => bridge.emitToRenderer(request));
acp.on("run-state", (coreId, state) => bridge.emitToRenderer({ coreId, state }));

const session = await acp.newSession("claude-code", cwd);
await acp.prompt(session.sessionId, "hello");
// 渲染层点了审批按钮之后：
acp.resolvePermission(requestId, { outcome: "selected", optionId });
```

退出时调用 `await acp.dispose()`，会 kill 所有核心进程并清空监听器。
