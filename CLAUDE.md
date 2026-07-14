# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 开发规范（必须遵守）

1. **必须使用中文回复**——所有对话、解释、提交说明默认使用简体中文。UI 文案中文，代码注释英文（沿用仓库习惯）。提交信息用**中文 conventional commits**（`feat:` / `fix:` / `chore:` 等）。
2. **禁止手写 style**——不允许内联 `style={}`、不允许新建 `.css` / `.scss` 文件（全局 `desktop/src/index.css` 中的 Tailwind 指令和 shadcn 主题变量除外）。所有样式必须通过 Tailwind 类名表达；确需动态样式时用 `cva` / `cn()` 组合类名。未经明确允许不得违反本条。
3. **组件一律用 shadcn/ui 现有组件组合实现**——shadcn 没有的先用其原语（Radix）组合，不引入其它 UI 库。添加组件：`pnpm dlx shadcn@latest add <name>`（本工程为 radix 基座 + nova 预设，见 `components.json`）。
4. **TypeScript 严格模式，禁止 `any`**——确实无法避免时用 `unknown` + 类型收窄。
5. **重逻辑下沉到 Rust command**——网络请求（含签名）、文件、密钥存储等在 `desktop/src-tauri/src/` 实现，前端只做展示与交互。**API Key 用系统安全存储（keyring）**，不得明文落盘、不得回传给前端展示。
6. **兼容性按 Safari（WKWebView）基线开发**——使用新 CSS/JS 特性前先确认 WKWebView 支持。browserslist（`desktop/package.json`）= `Chrome >= 111 / Safari >= 16.4`，经 `browserslist-to-esbuild` 接到 Vite 的 `build.target`。macOS 最低 **13.3**（= Safari 16.4，Tailwind v4 的硬底线）；Windows 用 evergreen WebView2（打包配置了 `downloadBootstrapper` 引导安装）。
7. **优先用主流方案**——状态管理 zustand（轻量优先）、数据请求 TanStack Query、构建 Vite、包管理统一 **pnpm**。能用现有抽象就不要自造轮子。

## 项目定位

**Tietiezhi（铁铁汁）**是一个以 **AI 模型中转 / 接入**为核心的桌面工具软件——中转站的官方桌面客户端：配置 baseURL + API Key 即可使用聊天等能力。**闭源项目**（LICENSE 为专有协议）。本期只做 **Windows 和 macOS**，其它端暂不考虑但架构上不排斥。logo 为章鱼图标（`assets/brand/tietiezhi-mark.png`）。

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
pnpm tauri dev               # 开发调试（启动 Vite + Rust 应用窗口）
pnpm tauri build             # 打包发布产物（dmg / nsis）
pnpm typecheck               # TypeScript 检查（tsc --noEmit）
pnpm build                   # 前端产物（tsc --noEmit && vite build）
cargo check                  # Rust 检查（在 desktop/src-tauri 下）
cargo test                   # Rust 单元测试（在 desktop/src-tauri 下）
pnpm tauri icon ../assets/brand/tietiezhi-mark.png   # 重新生成全套图标
```

## desktop/ 架构

### 前端（`desktop/src/`）

- **`components/ui/`** —— shadcn 生成的组件，原则上不手改（升级用 CLI 重拉）。
- **`components/`** —— 业务通用组件：`app-sidebar.tsx`（侧边栏导航）、`theme-provider.tsx`（浅色/深色/跟随系统，class 策略 + localStorage，key=`tietiezhi-theme`）。
- **`features/`** —— 按功能分模块：`chat/`（聊天）、`providers/`（接入配置）、`settings/`（设置）。
- **`stores/`** —— zustand：`ui.ts`（当前页面，**无路由库**，三页用状态切换）。
- **`lib/`** —— `utils.ts`（`cn()`）等工具与 API 封装。
- 应用标识：产品名 `Tietiezhi`，identifier `com.tietiezhi.tietiezhi`，窗口标题「铁铁汁」。

### Rust（`desktop/src-tauri/`）

- `src/main.rs` 只是入口；逻辑在 `src/lib.rs`（`run()`）。
- commands 按域拆分在 `src/commands/`；密钥存取封装在 `src/secrets.rs`（keyring，service = `com.tietiezhi.tietiezhi`）。
- 设置（baseURL、默认模型等非敏感项）以 JSON 存 `app_config_dir()/settings.json`；**API Key 只进钥匙串**。
- baseURL 归一化：用户填 `https://x.com` 或 `https://x.com/v1` 都可以，Rust 侧统一补 `/v1` 前缀后拼端点。
- 聊天走 OpenAI 兼容 `/v1/chat/completions`（`stream: true`），SSE 解析在 Rust 侧完成，经 `tauri::ipc::Channel` 把 `{type: delta|done|error}` 事件推给前端；解析器有 `cargo test` 单元测试。
- 能力声明在 `capabilities/default.json`（当前仅 `core:default`）。新增系统能力时先想想是否真的需要新权限。

## CI

- `.github/workflows/desktop.yml` —— Windows + macOS 双平台：typecheck + cargo check/test + `tauri build`（暂未签名/公证，后续再加）。
- `.github/workflows/server-ci.yml` —— Go 服务端（保持原样）。

## 文档状态

`README.md`（中文、闭源说明）与 `docs/ROADMAP.md` 改了对外行为记得同步；以源码为准。
