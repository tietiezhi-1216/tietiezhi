# Roadmap

> 2026-07 桌面端重构（Tauri 2 + React，见 `desktop/`）后的路线图。旧 Swift/Flutter 时期的条目已随实现一并移除（git 历史可查）。

## v0.1 —— 重构落地（进行中）

- [x] 仓库清理：移除 Flutter/Swift 历史实现，项目闭源化
- [x] Tauri 2 + React 工程骨架：图标、暗色模式、侧边栏导航、规范文档
- [ ] 接入配置页：中转站 baseURL + API Key（系统钥匙串存储）、测试连接（`/v1/models`）
- [ ] 聊天页：最简流式对话（OpenAI 兼容 `/v1/chat/completions`，SSE）
- [ ] 设置页：主题切换、关于信息
- [ ] Windows + macOS 构建 CI

## 之后

- [ ] 聊天历史持久化与多会话
- [ ] 多配置 / 多模型管理与切换
- [ ] Windows / macOS 签名、公证与自动更新
- [ ] 万物互联（server interconnect）客户端接入
- [ ] 用量 / 费用统计
