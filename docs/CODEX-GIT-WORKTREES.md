# Codex Local、Worktree 与 Handoff

## 范围

R29 以固定 `rust-v0.145.0` 的 Git 基线、分支安全和桌面执行环境行为为基线，在 Tauri Rust 进程内实现每个任务唯一的 Local/Worktree 环境。运行时不调用、链接或分发 Codex 二进制。

## 环境模型

- Work 与 Code 是工具和交付方式，不再拥有两个可写目录；同一任务、Thread 和聊天始终解析到同一个执行环境。
- Git 项目默认使用 detached Worktree；普通目录和未绑定项目的任务默认使用 Local。
- Local 直接使用用户选择的项目目录。Worktree 位于应用数据任务目录，隔离修改并保持原仓库当前 tracked、untracked 和未提交补丁。
- Local 与 Worktree 可显式切换；切回 Worktree 会复用原目录，不重复创建第二棵工作树。
- R29 前的 `task/workspace`、`workspaces/code` 和 `workspaces/work` 会按确定顺序原地接管。已注册 worktree 不移动路径，避免破坏 Git common metadata。

## Worktree Include

- 仓库根 `.worktreeinclude` 使用有序 glob 规则补充默认忽略文件，`!` 表示后续排除。
- 每个文件最多 100 MB，总计最多 1 GB；绝对路径、`..`、symlink 和仓库外路径全部拒绝。
- tracked dirty patch、普通 untracked 文件和显式 include 只在首次创建 Worktree 时复制。

## Snapshot 与 Restore

- Snapshot 使用独立临时 Git index 和 `refs/tietiezhi/snapshots/{task}/{snapshot}` 私有引用。
- Snapshot 收录 tracked、untracked 和 `.worktreeinclude` 文件，但不修改用户 index、当前分支或 HEAD。
- Restore 只允许在 Worktree 环境执行。当前存在改动时先自动保存 pre-restore Snapshot，再 `reset --hard` 和清理未跟踪文件。
- 删除任务前先保存 final Snapshot，然后注销 worktree。Snapshot 引用和外置状态位于源仓库及 `agent-runtime/git-workspaces`，不会随任务目录删除。

## Handoff

- Handoff 先创建 Snapshot，再从该 commit 创建显式分支或默认 `codex/{task}-{slug}` 分支。
- Handoff 不 checkout 分支，不改变用户工作树和当前分支；重复分支名、非法 ref 和 Local 环境会被拒绝。
- 前端显示 detached HEAD、快照历史、恢复确认和 Handoff 结果，Work/Code 切换不再提供文件复制入口。

## 安全边界

- 内部 Git 命令禁用 Hooks，所有任务 ID、Snapshot ID、分支和路径经过独立校验。
- 快照使用 alternate index，防止污染用户暂存区；写状态使用临时文件、`fsync` 和原子重命名。
- 普通目录不会伪造 Git Snapshot；Local Git 项目可以创建 Snapshot，但只有隔离 Worktree 可以 Restore 与 Handoff。

## 验证

- `agent-git` 覆盖 detached 创建、dirty/untracked/include 同步、Local/Worktree 复用、Snapshot/Restore、用户 index 不变、Handoff、删除前快照和旧 worktree 原地接管。
- 桌面 Rust 覆盖共享工作方式、严格相对路径和提示词环境契约。
- 前端门禁覆盖 Local、Worktree、Snapshot、Restore、Handoff、detached HEAD，并拒绝重新出现旧双空间导入文案。
- CI 在 macOS 与 Windows 独立运行 `agent-git`、桌面 Rust、TypeScript、迁移检查和生产构建。
