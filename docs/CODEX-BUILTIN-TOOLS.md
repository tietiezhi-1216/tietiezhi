# Codex 基础工具

## 基线

R11 对齐固定版本 `rust-v0.145.0` 的基础工具 Schema、Responses 工具循环、结构化输出和强类型 Item。实现位于 `crates/agent-tools`、`crates/agent-core` 与 `desktop/src-tauri/src/commands/codex.rs`，不调用或打包 Codex 二进制。

## 已接入工具

| 工具 | 行为 |
| --- | --- |
| `clock.curr_time` | 返回 UTC 时间，保持 Codex 的 namespace、Schema、输出 Schema 和模型可见文本格式 |
| `clock.sleep` | 最长 12 小时；用户在同一 Turn steer 新输入时提前结束，但不取消 Turn |
| `get_context_remaining` | 每次调用从当前 Thread 状态读取剩余 Token，不使用启动时快照 |
| `view_image` | 解析 Thread cwd 下的本地文件并返回 Responses 结构化图片内容；只对支持图片输入的模型暴露 |
| `web_search` | 使用 Responses 托管 `web_search`，不在客户端重复发起网络请求 |
| `tool_search` | 使用英文 BM25 搜索延迟工具，返回下一次 Responses 请求可加载的原始工具 Schema |

`view_image.detail=original` 只对固定模型目录中明确支持原图的模型开放。未知自定义模型默认只使用 `high`，不会假定能力。

## Responses 工具循环

1. Registry 的模型可见工具生成 Responses `tools`。
2. SSE `response.output_item.done` 中的 Function、Custom 和客户端 Tool Search 调用进入统一 Router。
3. 同批可并行工具通过 R10 的读锁并发执行；写工具继续互斥。
4. 工具结果按模型调用顺序写入 canonical rollout。
5. `function_call_output`、`custom_tool_call_output` 或 `tool_search_output` 进入下一次 Responses 请求。
6. Tool Search 返回的延迟 Schema 在后续请求中去重加载。
7. 未知工具、参数错误和 Handler 错误作为模型可见失败结果返回，不终止 Turn。

## Item 与恢复

- 托管 Web Search 投影为 `webSearch` Item。
- `view_image` 投影为 `imageView` Item。
- `clock.sleep` 投影为 `sleep` Item。
- 三类 Item 均发送 `item/started`、`item/completed` 并写入 rollout。
- Function Call 与 Tool Output 保持 Responses 原始顺序，崩溃恢复时不会丢失因果链。
- Turn interrupt 使用独立 CancellationToken；steer 输入只触发工具活动信号。

## 后续边界

- R12 已实现 `apply_patch` 与 File Change/Diff，见 `docs/CODEX-PATCH.md`。
- R13 实现 `exec_command`、`write_stdin`、PTY 和后台进程。
- R14-R18 实现审批、沙箱、网络和 ExecPolicy。
- R19 将 MCP 工具注册为延迟或直接工具。
- R25 实现 Plan、Request User Input 和 Goal。

这些阶段继续复用同一 Tool Registry 和 Responses 循环，不建立旁路执行器。

## 验证

- 基础工具 Schema、输出与边界。
- sleep 超时、输入打断和 Turn 取消分离。
- 图片结构化内容与模型能力门控。
- BM25 Tool Search、来源去重和延迟 Schema。
- Responses 请求工具表去重。
- Function Call 捕获和并行执行。
- 工具 Output 进入 canonical 历史。
- Sleep、Image View、Web Search 强类型 Item 与恢复转换。
