# AGENTS.md

本文件是本仓库所有 AI 编码代理与贡献者的唯一开发规范来源。

## 开发规范

1. 必须使用简体中文回复。UI 文案中文，代码注释英文，提交信息使用中文 conventional commits。
2. 禁止内联 `style={}`，禁止新建业务 CSS/SCSS。样式使用 Tailwind；全局主题只允许放在 `app/src/renderer/index.css`。
3. UI 使用 `app/src/renderer/components/ui/` 中的 shadcn/ui 组件和 Radix 原语，不引入其他 UI 库。
4. TypeScript 严格模式，禁止 `any`。无法确定的外部值使用 `unknown` 并收窄。
5. Renderer 不得直接访问 Node.js、AI SDK、数据库、文件或凭据。所有重逻辑位于 Electron Main。
6. API Key 使用 Electron `safeStorage`，不得明文落盘；SQLite 只保存 `credentialRef`。
7. 默认直接在 `main` 分支开发，禁止 Git Worktree 和日常功能分支。
8. 不得恢复 Tauri、Rust Runtime、ACP、MCP、Tietiezhi、Automations 或 Cores 模块。

## 产品范围

Tietiezhi 当前是 Electron + TypeScript 桌面 AI 应用，只保留两个产品模块：

- Workspace：基于统一 `AIEngine` 和 `EngineEvent` 的 AI SDK `ToolLoopAgent`。始终绑定项目目录；未选择项目时创建 UUID 临时 Workspace。
- Create：基于 AI SDK `generateImage` 的图片生成与本地资产管理。

Workspace 内置受限文件工具、Shell、审批和 Diff；第一阶段不包含 MCP、外部 CLI、视频、多 Agent、自动化和设备互联。

## 仓库结构

- `app/`：Electron 主应用。
- `app/src/main/application/`：Conversation、Engine、Provider、Media 应用服务。
- `app/src/main/engines/`：AI SDK Engine 和 Provider 工厂。
- `app/src/main/infrastructure/`：SQLite 与安全凭据存储。
- `app/src/preload/`：类型化 Electron IPC。
- `app/src/renderer/`：React 19 + Tailwind + shadcn/ui。
- `app/src/shared/`：Main、Preload、Renderer 的稳定契约。
- `server/`：保留的 Go 服务。
- `website/`：官网。

## 常用命令

在 `app/` 下执行：

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm dist:mac
pnpm dist:win
pnpm smoke:package <已打包应用可执行文件>
```

无窗口主进程检查：

```bash
TIETIEZHI_HEADLESS=1 ./node_modules/.bin/electron .
```

## 架构约束

- UI 只调用 `window.tietiezhi`。
- Application Core 只依赖自有消息和事件类型。
- 只有 `app/src/main/engines/` 可以导入 AI SDK Provider。
- 所有流式输出必须先转换为带 `schemaVersion` 的 `EngineEvent`。
- 会话、消息、Run、Provider、MediaJob 和 Artifact 使用 SQLite。
- 图片原始文件保存在应用数据目录，Renderer 只能通过受限的 `tietiezhi-media://` 协议读取。
- 停止生成必须取消真实 Provider 请求。
- 所有工具路径必须限制在会话 Workspace；文件写入、替换和 Shell 命令必须经过 UI 审批。
