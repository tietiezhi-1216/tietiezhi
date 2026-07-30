<div align="center">

<img src="./assets/brand/tietiezhi-mark-transparent.png" alt="Tietiezhi" width="120">

# Tietiezhi

**基于 AI SDK 的 Electron 桌面 AI 应用。**

</div>

## 当前能力

Tietiezhi 当前聚焦两个模块：

| 模块 | 能力 |
| --- | --- |
| Workspace | AI SDK `ToolLoopAgent`、项目或 UUID 临时目录、文件工具、Shell、统一审批、Diff、文件预览、流式响应和会话持久化 |
| Create | AI SDK 原生图片生成、比例与数量设置、异步任务、停止、重试、删除和本地图片资产 |

Workspace 始终以 Agent 方式运行：用户未选择项目时，应用创建 UUID 临时 Workspace，工具仍只在该目录内工作。应用不依赖任何外部 CLI；当前不提供 MCP、视频、多 Agent、自动化或设备互联。

应用保留 Tietiezhi Gateway 账号入口。用户可以通过系统浏览器完成 PKCE 授权，登录后自动获得内置中转站凭据并同步模型，无需手工填写 API Key；也可以继续配置 OpenAI、Anthropic、Google 或 OpenAI-compatible 供应商。

## 架构

```text
React Renderer
  -> Typed Preload IPC
  -> Application Core
  -> EngineManager
  -> AISDKEngine / ToolLoopAgent
  -> Restricted Workspace Tools / Approval
  -> EngineEvent
  -> SQLite / Renderer
```

- Renderer 不接触 AI SDK、API Key、SQLite 和本地文件。
- 中转站 Session 与 API Key 通过 Electron `safeStorage` 加密。
- SQLite 只保存 Provider 的 `credentialRef`。
- 对话和图片生成共用 Provider 配置。
- 文件路径经过 Workspace 边界检查；写入、替换和 Shell 命令必须由用户审批。
- 图片文件通过受限的 `tietiezhi-media://` 协议展示。

## 开发

要求 Node.js 24+ 和 pnpm 10。

```bash
cd app
pnpm install
pnpm dev
```

验证：

```bash
pnpm typecheck
pnpm test
pnpm build
TIETIEZHI_HEADLESS=1 ./node_modules/.bin/electron .
pnpm smoke:package <已打包应用可执行文件>
```

打包：

```bash
pnpm dist:mac
pnpm dist:win
```

## 仓库

| 目录 | 说明 |
| --- | --- |
| `app/` | Electron 桌面应用 |
| `server/` | Go 服务 |
| `website/` | 官网 |
| `assets/` | 品牌资源 |

项目采用 [Apache License 2.0](./LICENSE)。
