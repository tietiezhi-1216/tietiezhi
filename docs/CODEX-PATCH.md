# Codex Apply Patch 与 Diff

## 范围

R12 在 Tauri Rust 进程内实现 Codex `apply_patch`，不运行或嵌入上游二进制。

- Responses API 使用 `type: custom` 的自由格式工具。
- 工具定义使用固定版本 Codex 的 Lark grammar。
- 支持添加、删除、更新、移动和 `*** End of File`。
- 解析器兼容 Codex 的 heredoc 宽容模式和分段 SSE 输入。
- 上下文定位依次尝试精确、忽略尾部空白、忽略两端空白和 Unicode 标点归一化。

## 原子提交

`crates/agent-patch` 将解析与写盘拆开：

1. 规范化所有路径并拒绝工作区外路径。
2. 检查最近存在父目录的 canonical path，拒绝 symlink 逃逸。
3. 读取所有输入并在内存中依序预演全部 hunk。
4. 任意语法、路径、UTF-8 或上下文错误都在写盘前返回。
5. 所有新内容先写入工作区内同文件系统 staging 目录。
6. 原文件重命名为事务备份，再以原子 rename 替换。
7. 任一提交步骤失败时，按逆序删除新内容、恢复备份并清理新目录。

因此跨多个文件的 Patch 不会因后续 hunk 失败而留下部分修改。

## Item 与通知

- 首次得到可解析 Patch 后创建 `fileChange` Item，状态为 `inProgress`。
- 增量或最终预览发送 `item/fileChange/patchUpdated`。
- 成功、失败或拒绝后以同一 Item ID 发送 `item/completed`，状态分别为 `completed`、`failed` 或 `declined`。
- 每次成功提交后按 Turn 初始文件内容重新聚合 Diff，并发送 `turn/diff/updated`。
- `item/fileChange/outputDelta` 仅保留协议兼容发布器；与 Codex 0.145.0 一致，新执行路径不发送该废弃通知。
- Core rollout 持久化 canonical `FileChange` Item，恢复时转换回 V2 `fileChange`。

## 审批边界

R12 已实现 `item/fileChange/requestApproval` 反向 JSON-RPC 请求和四种决定：

- `accept`
- `acceptForSession`
- `decline`
- `cancel`

审批等待期间 Thread 状态包含 `waitingOnApproval`。`cancel` 同时取消当前 Turn。R14 将继续实现完整 Approval Policy、精确会话授权缓存和命令/网络统一审批；R15-R17 提供真正的 OS 沙箱与网络隔离。

## 验证

- 上游 Parser、Streaming Parser 和 Seek Sequence 共 20 项移植测试。
- 新增事务、路径逃逸、symlink 逃逸、预演零写入和累计 Diff 测试。
- Approval Broker 验证 V2 Schema、四种决定和独立请求 ID 命名空间。
- Tool Runtime 验证自由格式 Schema、批准执行、拒绝零写入和模型 Output。
- Core 验证 FileChange rollout、Patch Updated、废弃 Output Delta 与 Turn Diff 的 V2 载荷。
- Desktop 全量 Rust、TypeScript、生产构建和旧任务迁移继续作为阶段门禁。
