# Roadmap

> 2026-07 桌面端重构（Tauri 2 + React，见 `desktop/`）后的路线图。旧 Swift/Flutter 时期的条目已随实现一并移除（git 历史可查）。

## v0.1 —— 重构落地（进行中）

- [x] 仓库清理：移除 Flutter/Swift 历史实现，统一桌面端技术栈
- [x] Tauri 2 + React 工程骨架：图标、暗色模式、侧边栏导航、规范文档
- [x] 接入配置页：中转站 baseURL + API Key（系统钥匙串存储）、测试连接（`/v1/models`）
- [x] 聊天页：最简流式对话（OpenAI 兼容 `/v1/chat/completions`，SSE）
- [x] 设置页：主题切换、关于信息
- [x] Windows + macOS 构建 CI

## 之后

- [ ] 聊天历史持久化与多会话
- [ ] 多配置 / 多模型管理与切换
- [ ] Windows / macOS 签名、公证与自动更新
- [ ] 万物互联（server interconnect）客户端接入
- [ ] 用量 / 费用统计

## 长期愿景（生态方向）

> 终局定位：以**万物互联**为核心、结合 Agent 智能体、整合多模态（向量/文本/语音/音乐/视频/图片）模型的**完整软件生态**。桌面端从「中转站客户端」演进为承载整个 hub 的入口。以下为方向性规划，非近期迭代项；大部分能力在 `server/internal/` 已有模块骨架，桌面端侧重「接入 + 呈现 + 编排」。

### 1. 聊天与集成
- [ ] 集成 Codex / Claude Code / opencode / 国内 QwQ 等平台的聊天能力
- [ ] 「聊天胶囊」
- server 侧骨架：`agent/` `subagent/` `tool/` `mcp/` `skill/` `channel/`

### 2. 自动化与工作流编排
- [ ] AI 自动化截图
- [ ] 节点式工作流编排：不同模型之间自由配置节点、连线
- [ ] 手写脚本 / AI 生成自动化工作流，落地短剧、电商等场景
- server 侧骨架：`scheduler/` `cron/` `command/` `hook/` `sandbox/` `workspace/`

### 3. 中转与私有化嵌入
- [ ] 将同级 `server/` 中转站直接内置进桌面端（无需额外暴露入口）
- [ ] 向 Claude Code / Codex 暴露本地 API 端点，使其能接外部 API
- server 侧骨架：整个 `server/` 单二进制；多模态 `media/` `llm/`、万物互联 `interconnect/`

> 两个地基级架构决策待定：① `server/` 以 Tauri sidecar 进程内置本地跑，还是桌面只连远程 server；② 桌面端定位从「薄客户端」放宽到「hub 壳」后，`CLAUDE.md` 相关规范（「不动 server / 前端只做展示」）的边界调整。
