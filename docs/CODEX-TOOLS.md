# Codex 工具内核

## 基线

R10 对齐固定版本 `rust-v0.145.0` 的 Tool Registry、Router、Lifecycle、模型结果和并行调度。实现位于 `crates/agent-tools`，不调用或打包 Codex 二进制。

## 注册与暴露

- `ToolName` 同时保存可选 namespace 和本地 name，路由时不做扁平名称猜测。
- Registry 拒绝同一 namespace/name 的重复注册。
- `ModelVisible` 工具进入 Responses 工具表。
- `Deferred` 工具已注册但等待 Tool Search 或模式切换后暴露。
- `Hidden` 工具既不暴露，也不能通过伪造模型调用绕过。
- 未注册、隐藏或载荷类型不匹配的调用返回结构化模型失败结果，不终止 Turn。

## 路由与结果

Router 解析 Responses 的：

- `function_call`
- `custom_tool_call`
- 客户端执行的 `tool_search_call`

服务端执行的 Tool Search 不会在本地重复运行。Function、Custom 和 Tool Search 分别生成对应的 Responses output Item，并保持原始 `call_id`。

Dynamic Tool 使用 App Server V2 的 `item/tool/call` 反向请求，参数包含 thread、turn、call、namespace、tool 和 JSON arguments；客户端响应必须包含 `contentItems` 和 `success`。

## 生命周期与取消

- 每次执行最多发布一次 Start。
- 成功、失败和取消只能取得一次终态所有权。
- 普通 Handler 在取消时立即 abort。
- 声明需要清理的 Handler 会收到 CancellationToken 并等待清理结束，但模型仍得到 aborted 结果。
- Lifecycle Contributor 为 R23 Hooks、审计与扩展提供统一入口。

## 并发门

每个 Turn Runtime 使用一个公平 `RwLock`：

- `supports_parallel_tool_calls = true` 获取读锁，可与其他并行工具同时执行。
- 其他工具获取写锁，与所有并行和串行工具互斥。
- namespace 不参与启发式判断，并行能力只来自实际注册 Handler。

R11-R13 在此内核上注册基础工具、Apply Patch 和 Unified Exec；R14-R18 在 Handler/Runtime 之间接入审批、沙箱、网络与 ExecPolicy，不另建工具循环。

## 验证

- 重复注册、隐藏暴露和确定性工具表。
- Function、Custom、Tool Search 路由。
- App Server V2 Dynamic Tool 请求与响应。
- 未知工具结构化失败。
- 并行读锁共享和串行写锁互斥。
- 取消只有一个终态。
