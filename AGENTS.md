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

Tietiezhi 当前从 Workspace 基础重新构建，只保留一个产品模块：

- Workspace：包含 `project` 项目目录和 `temporary` UUID 临时目录两种来源。
- Conversation：始终绑定一个 Workspace，并在 SQLite 中保存 Message。

当前阶段不包含模型 Provider、Agent Loop、工具、审批、Diff、Create、MCP、外部 CLI、多 Agent、自动化和设备互联。后续 Agent Core 必须建立在稳定的 Workspace、Conversation 和 Message 契约之上。

## 仓库结构

- `app/`：Electron 主应用。
- `app/src/main/application/`：Workspace 与 Conversation 应用服务。
- `app/src/main/infrastructure/`：SQLite 本地存储。
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
- Application Core 只依赖 `app/src/shared/` 中的自有契约。
- Workspace、Conversation 和 Message 使用 SQLite。
- Conversation 必须通过 `workspaceId` 绑定 Workspace，不得通过路径正则推断 Workspace 类型。
- Renderer 不得直接读取 Workspace 文件；路径解析和边界检查必须位于 Electron Main。
