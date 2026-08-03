# Tietiezhi 路线图

## 当前目标：Workspace 基础

- [x] 移除 AI SDK、Provider、Create 和旧 Agent Runtime
- [x] `WorkspaceKind = project | temporary`
- [x] 项目目录注册与持久化
- [x] UUID 临时 Workspace
- [x] Workspace、Conversation、Message SQLite 结构
- [x] 一个 Workspace 包含多个 Conversation
- [x] Message parts 与父消息关系
- [x] Electron Main、Preload、Renderer 最小调用链
- [ ] 项目移除与临时 Workspace 生命周期
- [ ] 文件树与文本预览
- [ ] Conversation 分支、编辑和搜索

## 下一阶段：自有 Agent Core

- [ ] ModelGateway 契约
- [ ] Agent Loop 状态机
- [ ] 版本化 AgentEvent
- [ ] Run 持久化与取消
- [ ] Context Builder
- [ ] Tool Registry 与 Tool Executor
- [ ] Workspace 路径策略
- [ ] 审批状态机

## 暂不实现

- Create 与媒体生成
- MCP、插件和多 Agent
- 外部 CLI Agent
- 自动化和设备互联
- Tauri 与 Rust Runtime
