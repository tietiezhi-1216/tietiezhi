# Codex Chronicle 长期记忆

## 范围

R28 以固定 `rust-v0.145.0` 为行为基线，在 Tauri Rust 进程内实现 Chronicle 长期记忆。运行时不调用、链接或分发 Codex 二进制。

## 数据模型

- `agent-runtime/memories.sqlite3` 保存 Stage 1 结果、Stage 2 作业租约、重试、水位和每个 Thread 的记忆模式。
- `agent-runtime/memories/` 保存用户可读的 `MEMORY.md`、`memory_summary.md`、`raw_memories.md` 与 `rollout_summaries/`。
- SQLite 是生成和协调状态；Markdown 是检索界面。文件写入使用同目录临时文件、`fsync` 和原子重命名。
- Thread 的 `enabled`、`disabled`、`polluted` 状态同时进入 canonical `session_meta`，SQLite 索引丢失后仍能从 rollout 恢复。

## 两阶段生成

- Stage 1 只选择非临时、非 Subagent、已空闲 6 小时且不超过 10 天的已完成 rollout，默认每次启动最多处理 2 条。
- Stage 1 使用固定上游提取提示、低推理等级和严格 JSON Schema，生成 raw memory、rollout summary 与可选 slug。
- Stage 1 可并发执行，作业使用独占 token、1 小时租约、失败退避和来源水位，崩溃后不会重复提交旧结果。
- Stage 2 使用全局租约，将最多 256 条有效结果同步到 `raw_memories.md` 和 `rollout_summaries/`，再用固定上游合并提示生成完整 `MEMORY.md` 与 `memory_summary.md`。
- 合并结果只允许两个受管 Markdown 文件，`memory_summary.md` 首行必须为 `v1`，验证通过后才原子替换。
- 内置 Gateway 在启动后台生成前读取额度。主窗口剩余额低于配置阈值或额度耗尽时跳过；额度服务暂时不可用时按 Codex 容错行为继续。

## 使用、引用和污染

- `memory_summary.md` 以最多约 2,500 Token 的 Developer Instruction 注入模型；完整文件只在需要时通过 `memories` 工具读取。
- `memories.list`、`memories.read` 和 `memories.search` 只允许访问受管根，拒绝绝对路径、`..`、symlink 和非 UTF-8 文件。
- `memories.add_ad_hoc_note` 只允许创建带时间前缀的不可覆盖 Markdown 笔记，不允许交互 Turn 直接改写生成的 `MEMORY.md`。
- 最终回答中的隐藏 `<oai-mem-citation>` 会被移除并投影为正式 `memoryCitation` Item；引用的 Thread usage count 和最后使用时间同步更新。
- 开启 `disable_on_external_context` 后，Web Search 或非 `memories` 命名空间的外部工具会把本 Thread 标记为 `polluted`，本 Turn 后续采样不再注入长期记忆，该状态跨重启保留。

## 开关、重置与迁移

- Tietiezhi 的 `memory_enabled` 是兼容总开关；Codex 分层配置可分别控制 `generate_memories`、`use_memories`、`dedicated_tools`、筛选阈值和提取/合并模型。
- 实验方法 `thread/memoryMode/set` 支持按 Thread 设置 `enabled` 或 `disabled`。
- 实验方法 `memory/reset` 清除生成结果、作业和受管文件，但保留每个 Thread 的模式，避免重置改变用户明确选择。
- 旧 Tietiezhi `MEMORY.md` 与 `memory/` 只复制到 `memories/extensions/tietiezhi/`，不删除原文件；根目录迁移标记保证重置后不会自动重复导入。

## 隐私和安全

- 记忆文件只保存在本机应用数据目录，不进入项目仓库。
- Stage 1 输出和 Stage 2 输入在落盘前执行常见密钥格式脱敏；提示明确把 rollout 与工具输出视为数据而非指令。
- 后台生成只使用当前 Thread 已选择的 Responses Provider，不创建旁路模型通道。
- `memory/reset` 参数必须为空，所有实验请求仍要求 JSON-RPC ID。

## 验证

- `agent-memory` 覆盖租约、重试、合并输入、引用、使用计数、开关、重置、路径逃逸、symlink、不可覆盖笔记、脱敏和旧数据幂等迁移。
- `agent-core` 覆盖 Thread 记忆模式、污染、canonical session 恢复和 `memoryCitation` Item。
- 桌面 Rust 测试覆盖额度阈值、Responses 接线和完整运行时编译。
- CI 运行独立 Memory crate、Core、桌面 Rust、协议快照、旧记录迁移、TypeScript 和生产构建。
