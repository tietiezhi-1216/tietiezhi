# Codex Diff 与 Git UI

## 范围

R32 在 R29 的唯一 Local/Worktree 环境上提供 Git 变更审查与交付：

- 文件树与 staged、modified、untracked 状态
- 已暂存和未暂存 unified diff
- 文件与 hunk 级审查意见
- 精确路径 stage、unstage、discard
- commit、非强制 push 和 GitHub Pull Request 链接

所有命令直接作用于任务绑定的唯一 Git 环境，不创建第二个工作区，也不使用上游 Codex 二进制。

## 安全边界

- Git 路径必须是项目内的规范相对路径，不接受绝对路径或 `..`。
- Stage、Unstage 和 Discard 必须至少带一个显式路径。
- Discard 只恢复选中的 tracked 文件；untracked 只删除选中的普通文件或 symlink，不递归删除目录。
- Discard 前由 UI 显示文件数量并要求二次确认。
- Commit 只接受 1 到 10,000 字节的说明且必须存在 staged 变更。
- Push 只能使用仓库已有 remote，分支名通过 `git check-ref-format --branch`，固定为非 force push。
- PR 链接从已有 remote 推导；当前只为 GitHub remote 生成 compare URL。
- Diff 每个阶段每个文件最多展示 512 KiB，二进制和截断状态显式标注。
- Git 子进程禁用仓库 Hook，避免查看、暂存或提交时执行非显式程序。

## 审查意见

Diff 行和 hunk header 可被选为上下文。桌面端通过 `tietiezhi:git-review-prompt` 把文件、hunk 和意见写入当前任务输入框，而不是绕开 Thread 新建另一段隐藏对话。用户仍明确提交该输入，后续修改继续使用同一工作区。

## 验证

- `cargo test --manifest-path crates/agent-git/Cargo.toml`
- `pnpm test:workspace-git-ui`
- `pnpm typecheck`
- `pnpm build`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`

测试覆盖路径隔离、Diff、Stage、Unstage、单文件回退、保留无关修改、Commit、本地 bare remote Push、PR URL 和未知 remote 拒绝。SSR 门禁覆盖完整操作入口及审查意见进入当前任务输入框。
