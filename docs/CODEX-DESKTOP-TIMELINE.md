# Codex Desktop 时间线

## 范围

R31 将桌面端从通用工具卡迁移到 App Server V2 的强类型 `ThreadItem` 投影，并实现固定协议中的桌面文件服务。

- `item/started`、各类增量和 `item/completed` 按稳定 Item ID 合并。
- Turn、Thread、Diff、Plan、警告和反向请求等待状态分别保存，不依赖展示文本推断状态。
- 18 类 `ThreadItem` 都有明确渲染分支：消息、推理、计划、命令、文件、MCP、动态工具、协作、Web、图片、Review、Hook 和压缩。
- 重启读取的 Turn Items 可通过同一 Store hydrate，实时通知和历史记录不会形成两套渲染模型。
- Legacy `ChatItem` 在 R38 完成任务迁移前继续只读共存；新 Runtime 不再把强类型 Item 压成旧工具卡。

## 桌面文件服务

`desktop/src-tauri/src/commands/codex_fs.rs` 实现：

- `fs/readFile`、`fs/writeFile`
- `fs/readDirectory`、`fs/createDirectory`、`fs/getMetadata`
- `fs/copy`、`fs/remove`
- `fs/watch`、`fs/unwatch`、`fs/changed`
- `fuzzyFileSearch`
- 模糊搜索会话更新和完成通知

边界：

- 所有路径必须是绝对路径。
- 读写单文件最大 100 MiB。
- 写入先落同目录临时文件；Unix 原子替换，Windows 使用备份恢复替换。
- 新路径从最深已存在父目录 canonicalize，目标本身不得是 symlink。
- 目录复制不跟随 symlink，且拒绝复制到来源内部。
- Watch 句柄和模糊搜索会话按 App Server connection 隔离。
- 搜索最多扫描 50,000 项、返回 50 项并跳过 `.git`。

文件服务提供协议能力，不绕过 R14-R18 的 Approval、Sandbox、Network 和 ExecPolicy。由模型触发的文件副作用仍必须通过 Tool Runtime 的安全边界。

## 前端事件

Tauri 发布：

- `codex-v2-notification`
- `codex-v2-server-request`

`desktop/src/stores/codex-timeline.ts` 是唯一 reducer。`desktop/src/features/chat/codex-timeline.tsx` 只负责按 `ThreadItem.type` 渲染。完成事件替换开始态 Item，因此最终状态、输出和耗时以服务端完成载荷为准。

## 验证

- `cargo test --manifest-path desktop/src-tauri/Cargo.toml commands::codex_fs::tests`
- `pnpm test:codex-timeline-ui`
- `pnpm typecheck`
- `pnpm build`
- `pnpm check:codex-schema`
- `pnpm test:codex-protocol-ts`

SSR 门禁验证 Item 生命周期合并、CommandExecution 渲染和 18 类 `ThreadItem` 的穷尽覆盖。Rust 测试验证模糊排序、`.git` 排除、匹配索引、symlink 与嵌套复制拒绝。
