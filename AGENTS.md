# AGENTS.md

本文件是本仓库对所有 AI 编码代理与贡献者的唯一开发规范来源。

This file is the single source of truth for repository conventions, workflow rules, and architecture notes for all AI coding agents and contributors.

## 开发规范（必须遵守）

1. **必须使用中文回复**——所有对话、解释、提交说明默认使用简体中文。UI 文案中文，代码注释英文。提交信息用中文 conventional commits（`feat:` / `fix:` / `chore:` 等）。
2. **禁止手写 style**——不允许内联 `style={}`、不允许新建 `.css` / `.scss` 文件（全局 `desktop/src/index.css` 中的 Tailwind 指令和 shadcn 主题变量除外）。所有样式必须通过 Tailwind 类名表达；确需动态样式时用 `cva` / `cn()` 组合类名。
3. **组件一律用 shadcn/ui 现有组件组合实现**——shadcn 没有的先用其原语（Radix）组合，不引入其它 UI 库。添加组件：`pnpm dlx shadcn@latest add <name>`。
4. **TypeScript 严格模式，禁止 `any`**——确实无法避免时用 `unknown` + 类型收窄。
5. **重逻辑下沉到 Rust command**——网络请求、文件、密钥存储等在 `desktop/src-tauri/src/` 实现，前端只做展示与交互。API Key 必须使用系统安全存储（keyring），不得明文落盘。
6. **兼容性按 Safari（WKWebView）基线开发**——使用新 CSS/JS 特性前先确认 WKWebView 支持。基线见 `desktop/package.json` browserslist。
7. **优先用主流方案**——状态管理 zustand、数据请求 TanStack Query、构建 Vite、包管理统一 `pnpm`。能用现有抽象就不要自造轮子。
8. **禁止使用 Git Worktree 进行开发或任务隔离**——Workspace、Automation 与本地调试一律直接使用选中的项目目录或共享 Local 工作区，不再创建、切换或依赖 Git Worktree。
9. **禁止使用其他 Git 分支进行日常开发**——默认始终直接在 `main` 分支修改、提交与发布；不要新建、切换或长期保留用于开发的功能分支。

## 项目定位

**Tietiezhi（铁铁汁）**是一个以 AI 模型中转 / 接入为核心的桌面工具软件，也是中转站的官方桌面客户端：配置 baseURL + API Key 即可使用聊天等能力。项目采用 Apache License 2.0 开源，当前只做 Windows 和 macOS。

长期愿景：从中转站客户端演进为以万物互联为核心、结合 Agent、整合多模态模型的完整生态，包括多平台聊天集成、节点式工作流编排与自动化，以及把 `server/` 能力内置进桌面并向 Codex、Claude Code、opencode、QwQ 等开发工具暴露本地兼容能力。相关边界和演进见 `docs/ROADMAP.md`。

## 仓库结构

- `desktop/`：桌面客户端主工程，Tauri 2 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui + zustand + TanStack Query + Vite。
- `server/`：Go 后端 hub，命令在 `server/` 下通过 `task` 执行。桌面端重构默认不动 `server/`。
- `shared/`：跨端对齐规格。
- `assets/brand/`：品牌资源。
- `docs/`：路线图、发布、架构等文档。

## 常用命令

在 `desktop/` 下执行：

```bash
pnpm install
pnpm tauri dev
pnpm dev:mock
pnpm tauri build
pnpm typecheck
pnpm build
cargo check
cargo test
pnpm tauri icon ../assets/brand/tietiezhi-mark.png
```

## app/ 常用命令（Electron 宿主 + 自研 agent 核心）

在 `app/` 下执行：

```bash
pnpm install
pnpm dev
pnpm build
pnpm typecheck
pnpm test:agent
pnpm probe:live
```

`TIETIEZHI_HEADLESS=1` 启动会注册全部命令后立即退出并打印命令清单，
用于在无 GUI 的情况下核对命令面（`npx electron .`）。
`TIETIEZHI_DATA_DIR` 可把数据目录指到临时路径，避免污染真实用户档案。

## 测试用的中转站

项目所有者提供了一个可随意用于测试的中转站，凭据放在 `app/.env.local`：

```
TIETIEZHI_TEST_BASE_URL=https://tietiezhi.vip
TIETIEZHI_TEST_KEY=<向所有者索取>
```

**这个文件被 `.gitignore` 忽略，凭据一律不得写进仓库。** 本仓库是公开的
（`tietiezhi-1216/tietiezhi`），提交上去的密钥会在几分钟内被自动扫描抓走。
需要在新机器上测试时，向所有者索取后自己创建这个文件。

该网关支持四种协议（`chat_completions` / `responses` / `anthropic_messages` /
`gemini_generate_content`），`GET /v1/models` 会返回每个模型的协议与推理能力，
是验证多协议路径的现成靶子。已知限制：它的 gemini 模型全是图像生成模型，
没有文本模型，所以 google 文本路径无法用它验证。

`pnpm probe:live` 会拿真实模型跑通「流式文本 → 工具调用 → 多步循环改文件 →
持久化后重放带 providerData 的历史」。改动 `src/main/agent/provider.ts` 后
务必跑一次：单元测试用桩服务器，覆盖不到真实供应商的拒绝行为。

**Node 的 fetch 无视一切代理配置**（不读 `HTTP_PROXY`，也不读系统代理）。
探针脚本自己带了 `NODE_USE_ENV_PROXY=1`；应用里注入的是 Electron 的
`net.fetch`，走 Chromium 网络栈，认系统代理与 PAC。在需要代理的网络上，
如果绕过这一层，每个请求都会以 `ECONNRESET` 结束且没有任何 HTTP 状态码。

## desktop/ 架构

### 开发调试

- `pnpm tauri dev` 独占端口 `1420`。不要手动 kill 该端口上的开发进程。
- 纯浏览器验证 UI 使用 `pnpm dev:mock`，端口 `1421`，配合 `?mock=1`。
- 前端改动走 Vite HMR；修改 `src-tauri/**.rs` 会触发重新编译并重启整个 app。

### 前端

- `desktop/src/components/ui/`：shadcn 生成组件，原则上不手改。
- `desktop/src/components/`：业务通用组件。
- `desktop/src/features/`：按功能分模块。
- `desktop/src/stores/`：zustand 状态管理。
- `desktop/src/lib/`：工具与 API 封装。

### Rust

- 入口在 `desktop/src-tauri/src/lib.rs`。
- commands 按域拆分在 `desktop/src-tauri/src/commands/`。
- 密钥存取封装在 `desktop/src-tauri/src/secrets.rs`。
- Workspace 的 Work / Code 已切换到 `crates/agent-*` Codex Runtime。
- 同一任务只有一个 Local 文件环境；禁止再创建、切换或依赖 Git Worktree。
- 项目目录可以是普通文件夹或 Git 仓库；任务直接使用所选项目目录或共享 Local 工作区。
- Workspace Agent 只走 App Server V2 协议；模型传输层支持 `responses`、`chatCompletions`、`anthropicMessages`、`geminiGenerateContent` 四种 wire API，由 Provider 配置或 `auto` 探测选定，实现在 `crates/agent-model/src/protocol_transport.rs`。官方 Gateway 固定使用 `responses`。

## CI 与发布

- `.github/workflows/desktop.yml`：桌面端 CI。
- `.github/workflows/release.yml`：推送 `v*` Tag 后构建和发布桌面安装包。
- 发布前在 `desktop/` 下执行 `pnpm version:timestamp`，同步版本号与 Tag。
- 应用更新通过 GitHub Releases 与 `updater-latest.json` 分发。

## 文档同步

- 对外行为变更后同步更新 `README.md` 与 `docs/ROADMAP.md`。
- 以源码和本文件为准。
