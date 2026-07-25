# Codex Runtime 迁移与切换

## 运行时切换

R38 将 Workspace 的 Work/Code 执行路径切换为 App Server V2：

1. 客户端为每个连接发送 `initialize`，再发送 `initialized`。
2. 新任务使用 `thread/start` 创建 UUIDv7 Thread。
3. 旧任务首次访问时原地导入 canonical rollout，保留原任务 ID、项目、工作区、标题和消息历史。
4. 每次执行使用 `thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt` 和强类型通知。
5. 审批使用 App Server 反向请求与 `serverRequest/resolved`，不再经过旧 `permissionRequest` 工具卡。
6. Workspace 不再注册 `chat_stream`，仓库中不存在 `run_agent_loop`；独立铁铁汁 Companion 使用明确命名的 `run_companion_loop`，不承载 Workspace 工具执行。

`desktop/scripts/check-codex-runtime-switch.mjs` 在 CI 中阻止旧 Workspace 入口重新出现。

## 数据迁移

- SQLite 是可重建索引，JSONL rollout 是 Thread 权威记录。
- 旧 `task.json` 在启动时通过 `migrate_tasks_to_codex` 原地导入，不复制任务目录或工作区。
- 导入写入新的 canonical `session_meta`，旧 checkpoint 保留，索引删除后仍可从 rollout 重建。
- 后续兼容快照不得覆盖 canonical model、provider、name、source 或 workspace 元数据。
- 归档、恢复和删除统一调用 Thread 生命周期；永久删除前仍执行 Worktree、终端与 Snapshot 清理。
- `task.json` 暂时保留为旧版本回滚锚点。回滚旧应用不会读取新 Item，但原有消息和工作区仍存在。

## 外部 Agent 导入

实现固定 App Server V2 的：

- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `externalAgentConfig/import/readHistories`
- `externalAgentConfig/import/progress`
- `externalAgentConfig/import/completed`

支持 Claude 与 Cursor 的项目指令、配置、Skills、Subagents、Hooks、Commands、MCP、Memory 和 Sessions。导入遵守以下边界：

- 所有源路径先 canonicalize，并限制在已检测的 `.claude`、`.cursor` 或项目范围内。
- 目录复制不跟随 symlink。
- 配置与历史使用同目录临时文件和原子重命名发布。
- 会话只读取检测到的 `projects` 根内 JSONL，并转换为 canonical Responses history。
- 已存在的目标文件不被无提示覆盖。
- Plugins 必须通过 Marketplace 安装，不从外部目录直接复制可执行扩展。
- Progress 与 Completed 通知在发送前通过固定 V2 Schema 校验。

## 连接兼容

- 未初始化的旧内部调用会进入显式兼容连接，但正式前端始终执行握手。
- `experimentalApi`、request attestation、MCP form elicitation 和通知 opt-out 按连接保存。
- 缺少 Responses Provider 时发送结构化 `warning`，不会静默回退 Chat Completions Agent。
- 初始化后发送 `deprecationNotice`，说明旧 Workspace Agent 已删除。

## 验证

- `cargo test --manifest-path crates/agent-state/Cargo.toml`
- `cargo test --manifest-path crates/agent-core/Cargo.toml`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
- `pnpm test:codex-runtime-switch`
- `pnpm test:conversation-migration`
- `pnpm test:codex-timeline-ui`
- `pnpm test:codex-approval-ui`
- `pnpm typecheck`
- `pnpm build`
