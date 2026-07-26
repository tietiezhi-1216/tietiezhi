# Codex Local Workspace 说明

## 状态

自 2026-07-26 起，桌面端 Workspace 与 Automation 已统一为 Local-only 模式。

## 当前规则

- Work 与 Code 共享同一个 Local 工作目录，不再创建或切换 Git Worktree。
- 绑定项目时直接在所选项目目录中工作；未绑定项目时使用共享 Local 工作区。
- Git 仓库仍支持读取状态和创建 Snapshot，但前端不再暴露 Restore、Handoff、detached HEAD 或环境切换。
- Automation 发布到项目目录时只校验其为 Git 仓库或工作目录，不再为每次运行创建独立 Worktree。

## 历史说明

本文件原先记录的 Worktree、Restore、Handoff 设计仅供历史参考，现已停用，不得恢复为默认开发路径。
