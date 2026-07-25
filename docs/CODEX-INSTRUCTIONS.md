# Codex 分层指令与 World State

## 上游基线

R20 对齐 OpenAI Codex `rust-v0.145.0` 的项目指令发现和 World State 更新，不调用或嵌入上游二进制。

## 项目指令发现

- 默认候选顺序为 `AGENTS.override.md`、`AGENTS.md`，同一目录只选择优先级最高的文件。
- 从最近的项目根标记 `.git` 开始，按父目录到当前工作目录的顺序加载。
- 没有项目根标记时只读取当前目录；空标记列表也禁止向父级遍历。
- fallback 文件名只能是当前目录下的普通文件名，拒绝 `/`、`\` 和路径穿越。
- 全部文件共享 32 KiB 字节预算，并以有损 UTF-8 读取，行为与固定上游版本一致。

## 模型上下文

每次模型步骤构建包含以下字段的 World State：

- AGENTS 内容、来源和作用目录
- `developerInstructions`
- Approval Policy 与 Sandbox Policy
- 当前可见工具名称
- 协作模式
- 当前目录、Shell、日期和 IANA 时区

首次写入使用完整 World State，后续使用 RFC 7386 Merge Patch。AGENTS 和开发者指令发生变化时会生成明确的替换或移除消息。

模型可见上下文片段先写为 canonical `response_item`，随后才写 `world_state`，以保留因果关系。因为 Turn 在上下文生成前已经接收用户消息，恢复层通过内部 Turn 标记把片段规范化到对应用户消息之前；发送 `/v1/responses` 和压缩请求时会剥离该内部标记。

## 恢复边界

- SQLite 仍只是可重建索引，基础指令保存在 canonical `session_meta`。
- World State 全量/补丁和上下文片段保存在追加式 rollout。
- 数据库损坏后从 `session_meta`、最新 `turn_context` 和 World State 恢复模型、目录、权限及开发者指令。
- Fork 保留原始 rollout 顺序。
- Compaction 清空 World State 差分基线，下一次模型步骤自动写入新的完整状态。

## 验证

- `crates/agent-config` 覆盖嵌套优先级、fallback、预算、有损 UTF-8、替换/移除、XML 转义和上下文排序。
- `crates/agent-core` 覆盖 response item 与 World State 写入顺序、索引损坏重建、基础/开发者指令恢复。
- 桌面测试覆盖基础指令进入 Responses 和 Compaction 请求，并验证内部恢复元数据不会发给模型。
