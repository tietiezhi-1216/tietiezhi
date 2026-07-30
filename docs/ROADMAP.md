# Tietiezhi 路线图

## 当前阶段

桌面端已经统一为 Electron + TypeScript，并删除 Tauri、Rust Agent Runtime、ACP、MCP、Cores、Automations 和设备助手。

当前产品只包含：

- Workspace：AI SDK `ToolLoopAgent`，始终绑定项目或 UUID 临时 Workspace，包含审批、Diff、工具时间线和文件预览。
- Create：AI SDK 原生图片生成，包含任务与本地资产管理。
- 账号：通过系统浏览器登录 Tietiezhi Gateway，自动管理内置中转站凭据和模型。

## 第一阶段

- [x] 统一 `AIEngine` 接口与版本化 `EngineEvent`
- [x] AI SDK 默认 Engine
- [x] OpenAI、Anthropic、Google 与 OpenAI-compatible Provider
- [x] SQLite 会话、消息、Run、Provider、MediaJob 和 Artifact
- [x] Electron `safeStorage` 安全凭据
- [x] Tietiezhi Gateway PKCE 登录、Session 校验、退出与模型同步
- [x] 流式文字、停止生成和用量
- [x] 受限文件读取、搜索、写入、替换和 Shell 工具
- [x] 写入与命令审批、工具时间线和 Diff 面板
- [x] Workspace 任务搜索、重命名、项目分组与文件预览
- [x] AI SDK 图片生成与本地资产
- [x] 图片异步任务、状态轮询、停止、重试和删除
- [x] macOS / Windows Electron CI 和 Release 骨架
- [ ] 会话重新生成、编辑后分支和搜索
- [x] Provider 模型在线发现与文字/图片模型筛选
- [ ] Provider 标准化能力元数据
- [ ] Adapter contract test 与 Renderer 端到端测试

## 后续阶段

- [ ] 可折叠 Workspace 文件树和独立终端输出面板
- [ ] Git 状态、增量 Diff 算法和变更回滚
- [ ] 工具策略、命令规则和审批记忆
- [ ] 图片编辑和参考图
- [ ] 独立封装的实验性视频 Adapter

## 非当前范围

- MCP、插件和多 Agent
- 自动化和设备互联
- 外部 CLI Agent
- Tauri 与 Rust 桌面 Runtime
