# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 开发规范（必须遵守）

1. **必须使用中文回复**——所有对话、解释、提交说明默认使用简体中文。UI 文案中文，代码注释英文（沿用仓库习惯）。提交信息用**中文 conventional commits**（`feat:` / `fix:` / `chore:` 等）。
2. **禁止手写 style**——不允许内联 `style={}`、不允许新建 `.css` / `.scss` 文件（全局 `desktop/src/index.css` 中的 Tailwind 指令和 shadcn 主题变量除外）。所有样式必须通过 Tailwind 类名表达；确需动态样式时用 `cva` / `cn()` 组合类名。未经明确允许不得违反本条。
3. **组件一律用 shadcn/ui 现有组件组合实现**——shadcn 没有的先用其原语（Radix）组合，不引入其它 UI 库。添加组件：`pnpm dlx shadcn@latest add <name>`（本工程为 radix 基座 + nova 预设，见 `components.json`）。
4. **TypeScript 严格模式，禁止 `any`**——确实无法避免时用 `unknown` + 类型收窄。
5. **重逻辑下沉到 Rust command**——网络请求（含签名）、文件、密钥存储等在 `desktop/src-tauri/src/` 实现，前端只做展示与交互。**API Key 用系统安全存储（keyring），不得明文落盘**（dev 构建例外，见下）。用户自己保存的 Key 在设置里默认掩码显示、可用眼睛切换成明文；应用不得内置用户或付费账户的真实 API Key。`Tietiezhi Gateway` 使用明确面向公开分发的免费客户端凭据，该凭据不是用户秘密，可随客户端发布。
6. **兼容性按 Safari（WKWebView）基线开发**——使用新 CSS/JS 特性前先确认 WKWebView 支持。browserslist（`desktop/package.json`）= `Chrome >= 111 / Safari >= 16.4`，经 `browserslist-to-esbuild` 接到 Vite 的 `build.target`。macOS 最低 **13.3**（= Safari 16.4，Tailwind v4 的硬底线）；Windows 用 evergreen WebView2（打包配置了 `downloadBootstrapper` 引导安装）。
7. **优先用主流方案**——状态管理 zustand（轻量优先）、数据请求 TanStack Query、构建 Vite、包管理统一 **pnpm**。能用现有抽象就不要自造轮子。

## 项目定位

**Tietiezhi（铁铁汁）**是一个以 **AI 模型中转 / 接入**为核心的桌面工具软件——中转站的官方桌面客户端：配置 baseURL + API Key 即可使用聊天等能力。项目采用 **Apache License 2.0** 开源。本期只做 **Windows 和 macOS**，其它端暂不考虑但架构上不排斥。logo 为章鱼图标（`assets/brand/tietiezhi-mark.png`）。

**长期愿景**：从「中转站客户端」演进为以**万物互联**为核心、结合 Agent、整合多模态（向量/文本/语音/音乐/视频/图片）模型的完整生态——多平台聊天集成（Codex / Claude Code / opencode / QwQ、聊天胶囊）、节点式工作流编排与自动化（AI 截图、短剧/电商场景）、把 `server/` 中转站内置进桌面并向 Claude Code / Codex 暴露本地 API。详见 `docs/ROADMAP.md`「长期愿景」。这些能力多数已在 `server/internal/` 有骨架；推进时「桌面端不动 server / 前端只做展示」等现行规范需重新划边界，落地某块前先与用户确认架构（`server` 作 sidecar 内置 vs 连远程）。

## 仓库结构

- **`desktop/`** —— 桌面客户端主工程（**开发主线**）：Tauri 2（Rust）+ React 19 + TypeScript 严格模式 + Tailwind CSS v4 + shadcn/ui + zustand + TanStack Query + Vite。
- **`server/`** —— Go 后端 hub（module `tietiezhi`），单二进制：OpenAI 兼容 API + Agent 运行时 + 飞书/Telegram 渠道 + 定时任务 + 内嵌 Web 控制台；万物互联层在 `server/internal/interconnect/`（WebSocket 设备注册 + 消息路由，`GET /v1/connect` / `GET /v1/devices`）。命令在 `server/` 下用 `task`（见 `server/Taskfile.yml`）。**桌面端重构不动 server。**
- **`shared/`** —— 跨端对齐的规格（单一事实源，当前为空壳）。
- **`assets/brand/`** —— 章鱼 logo 源文件；desktop 图标由它经 `pnpm tauri icon` 生成。
- **`docs/`** —— 路线图等文档。

> 历史：仓库曾包含 Swift（`apple/`）与 Flutter（`app/`）客户端，2026-07 重构时删除（git 历史可查）。旧的 TCC/签名规则等随之作废。

## 常用命令（在 `desktop/` 下执行）

```bash
pnpm install                 # 装依赖
pnpm tauri dev               # 开发调试（启动 Vite + Rust 应用窗口）——占用端口 1420
pnpm dev:mock                # 纯浏览器跑 UI（端口 1421），配合 http://localhost:1421/?mock=1
pnpm tauri build             # 打包发布产物（dmg / nsis）
pnpm typecheck               # TypeScript 检查（tsc --noEmit）
pnpm build                   # 前端产物（tsc --noEmit && vite build）
cargo check                  # Rust 检查（在 desktop/src-tauri 下）
cargo test                   # Rust 单元测试（在 desktop/src-tauri 下）
pnpm tauri icon ../assets/brand/tietiezhi-mark.png   # 重新生成全套图标
```

## desktop/ 架构

### 开发调试

- **`pnpm tauri dev` 独占端口 1420**（vite `strictPort: true`）。**绝不要 kill 1420 上的进程**——那是 tauri dev 的 `beforeDevCommand`，杀掉会让 app 窗口还在但白屏（`beforeDevCommand terminated with a non-zero status code`）。
- 要在**普通浏览器**里验证 UI（无需 Rust 侧），用 `pnpm dev:mock`（端口 **1421**）+ `?mock=1`：`src/dev/tauri-mock.ts` 会 stub `window.__TAURI_INTERNALS__`。入口在 `import.meta.env.DEV && ?mock` 时才动态 import 它，**正式构建会被 tree-shake，产物零残留**。不要再往 `index.html` 注入 mock 脚本。
- 前端改动走 Vite HMR 秒生效；**改 `src-tauri/**.rs` 会触发重新编译并重启整个 app**（无 HMR）。

### 前端（`desktop/src/`）

- **`components/ui/`** —— shadcn 生成的组件，原则上不手改（升级用 CLI 重拉）。
- **`components/`** —— 业务通用组件：`app-sidebar.tsx`（侧边栏：顶层功能区切换 + 工作区任务列表 + 左下角设置入口）、`product-area-switcher.tsx`（铁铁汁 / 工作区 / Automations / Create）、`workspace-mode-switcher.tsx`（工作区内 Work / Code 切换）、`theme-provider.tsx`（浅色/深色/跟随系统，class 策略 + localStorage，key=`tietiezhi-theme`）。
- **`features/`** —— 按功能分模块：`chat/`（聊天页 + Work / Code）、`create/`（图片 / 视频创作、生成记录与本地资产）、`automations/`（自动化编辑与运行）、`settings/`（设置页）。
- **`stores/`** —— zustand：`ui.ts`（当前功能区与页面状态，**无路由库**）、`chat.ts`（会话与流式发送）、`create.ts`（图片 / 视频草稿、任务与资产）、`automations.ts`（自动化状态）。
- **`lib/`** —— `utils.ts`（`cn()`）等工具与 API 封装。
- 应用标识：产品名 `Tietiezhi`，identifier `com.tietiezhi.tietiezhi`，窗口标题「铁铁汁」。

### Rust（`desktop/src-tauri/`）

- `src/main.rs` 只是入口；逻辑在 `src/lib.rs`（`run()`）。
- commands 按域拆分在 `src/commands/`；密钥存取封装在 `src/secrets.rs`（keyring，service = `com.tietiezhi.tietiezhi`）。
- **Agent 体系**（2026-07-16）：`src/agent/`（工具调用环路 `loop_.rs`、事件 `events.rs`、默认系统提示词 `prompt.rs`）、`src/tools/`（内置工具 read_file/write_file/edit_file/list_dir/glob/grep/bash/fetch/skill，路径 jail 限制在当前工作目录内）、`src/permission/`（三模式 ask/auto/full，PermissionBroker oneshot 阻塞等前端 `permission_respond`）、`src/skills/`（`app_data_dir()/skills/{name}/SKILL.md`，Anthropic 规范）、`src/mcp/`（基于官方 rmcp SDK 的 stdio + streamable HTTP 客户端，配置存 settings，工具名 `mcp__{server}__{tool}`）。`skill` 仅在本轮存在已启用且当前智能体可访问的技能时暴露，参数枚举和执行端都限制为真实可用名称；没有可用技能时，提示词明确区分 Skills 与内置工具。智能体档案存 `app_config_dir()/agents.json`（提示词/模型覆盖/skills/MCP/工具/权限模式）。工作区中的同一个任务共享消息和上下文，但 Work / Code 分别使用 `app_data_dir()/tasks/{task_id}/workspaces/{work|code}`：Git 项目按模式创建独立 worktree，普通项目按模式创建独立目录快照，未绑定项目则创建空白托管目录。Work 默认面向研究与成果交付，不暴露通用 `bash`；Code 保留完整开发工具面。工具不仅在模型请求中按模式过滤，执行环路也必须再次校验，禁止模型构造未暴露工具调用。注意 rmcp 依赖 reqwest 0.13，与主工程 0.12 并存（Cargo.toml 里别名 `reqwest13`）。
- 首次启动不预置供应商、baseURL 或 API Key；所有模型服务均由用户在设置中添加。请求类命令（聊天/模型列表）在 Rust 侧从 settings/keyring 解析连接信息，前端不回传连接信息。
- **模型能力**：`shared/model-registry/models.json` 是内置兜底注册表；运行时按「用户覆盖 > 渠道 `/v1/models` 扩展元数据 > 内置注册表 > 名称推断」解析输入/输出模态、工具调用和思考等级。用户覆盖与自动识别分开持久化，刷新模型列表不得清除。MCP 通过原生 function calling 暴露，不支持或能力未知的模型以纯对话运行。Reasoning Effort 在 UI 中统一使用英文值（Auto / Low / Medium / High 等）。
- **Gateway 账号**：官方 Gateway 登录必须保持可选，使用系统浏览器 + PKCE S256 + 本机回环回调。设备会话和 Gateway 签发的 API Key 分别保存到 keyring，优先级高于手动 Provider Key；退出登录同时吊销服务端设备会话并清理本地凭据。
- **Gateway 额度中心**：钱包、套餐、最近消费、套餐目录和订单状态只允许由 Rust command 使用 keyring 中的设备会话请求；前端不得接触会话令牌。购买前必须明确展示套餐价格与支付宝/微信并二次确认，确认后由 Rust 打开系统浏览器，前端轮询订单成功后立即刷新额度；未登录和未配置支付渠道时都保持非强制、可继续使用客户端。
- 设置（baseURL、默认模型等非敏感项）以 JSON 存 `app_config_dir()/settings.json`；**API Key 只进钥匙串**。
- **任务记录**在 `src/commands/conversations.rs`：每个任务存于 `app_data_dir()/tasks/{uuid}/task.json`，包含共享消息、项目绑定和当前 `task_mode`；旧记录缺少该字段时默认 Code。切换 Work / Code 不创建新任务，只改变下一轮 Agent 使用的独立执行空间。`task_workspace_overview` 只读扫描两种空间的成果、Git 变更和可交接文件；`transfer_task_workspace_file` 将用户明确选择的文件复制到目标空间 `.tietiezhi/imports/{来源模式}/`，不自动同步或覆盖项目文件。id 由前端 `crypto.randomUUID()` 生成并由 Rust 严格校验，`updated_at` 由 Rust 落盘时生成。归档只设置 `archived_at` 并保留完整目录，可在设置中恢复；`pinned_at` 控制侧边栏独立置顶分组；永久删除才清理任务目录及其 worktree。旧 `conversations/{uuid}.json` 与 `workspaces/{uuid}` 启动时自动迁移，旧版单 `workspace/` 优先迁入 Code 空间。
- **项目列表**在 `src/commands/projects.rs`：持久化到 `app_data_dir()/projects.json`，支持重命名和打开真实目录；任务可不绑定项目。项目可以是普通文件夹或 Git 仓库，Agent 在首次进入对应模式时从所选项目创建隔离执行空间，不直接修改用户选择的原目录；项目真实目录永不随任务删除。
- baseURL 归一化：用户填 `https://x.com` 或 `https://x.com/v1` 都可以，Rust 侧统一补 `/v1` 前缀后拼端点。
- 聊天走 OpenAI 兼容 `/v1/chat/completions`（`stream: true`），SSE 解析在 Rust 侧完成，经 `tauri::ipc::Channel` 把 `{type: delta|done|error}` 事件推给前端；解析器有 `cargo test` 单元测试。
- 能力声明在 `capabilities/default.json`（当前仅 `core:default`）。新增系统能力时先想想是否真的需要新权限。

## CI

- `.github/workflows/desktop.yml` —— Windows + macOS 双平台：typecheck + cargo check/test + `tauri build`。macOS 签名+公证已接入：配齐 `APPLE_*` secrets（证书 p12、签名身份、Apple ID、app 专用密码、Team ID）后 `tauri build` 自动签名/公证/装订；未配置则回退 ad-hoc。
- **发布与应用内自动更新**由 GitHub 承担：`.github/workflows/release.yml` 在推送 `v*` Tag 后构建 macOS universal 与 Windows 安装包，用 `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` 签名，生成 `updater-latest.json` 并创建 GitHub Release。版本号统一采用北京时间 `YYYY.M.D-tHHmmss`（`t` 避免凌晨小时的前导零违反 SemVer）；发版前在 `desktop/` 执行 `pnpm version:timestamp`，脚本会同步 `package.json`、Tauri 与 Cargo 版本，并输出对应 Tag 和 Microsoft Store 四段版本。时间版本按稳定版发布，`-alpha/-beta/-rc` 等其它后缀仍标为 Pre-release。应用更新端点固定为 GitHub Latest Release asset。直装版本启动后静默检查并自动下载更新，只有完整下载后才在右上角显示主题色涟漪更新按钮；无更新、检查中或下载中均不显示该入口。Microsoft Store 版本继续由商店管理更新。
- `.github/workflows/pages.yml` 将 `website/public/` 发布到 GitHub Pages；官网通过 GitHub Releases API 获取版本和下载链接，不依赖自建分发服务器。
- `.github/workflows/server-ci.yml` —— Go 服务端（保持原样）。

## 文档状态

`README.md`（中文、开源许可说明）与 `docs/ROADMAP.md` 改了对外行为记得同步；以源码为准。
