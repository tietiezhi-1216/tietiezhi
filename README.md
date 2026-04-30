# tietiezhi

> 轻量级本地 AI Agent 框架 — Go 核心 + 原生 UI

tietiezhi（铁铁汁）是一个用 Go 开发的轻量级本地 AI Agent 框架，目标是让每个人都能在自己的设备上运行一个智能终端。类似于 Codex / Claude Code 的本地化方案，但可以跑在手机上。

## ✨ 核心特性

- **多厂商 LLM 接入** — 支持所有主流 AI 厂商，支持流式输出
- **本地化优先** — 所有数据存储在本地，无需云服务，隐私安全
- **工作区系统** — 不同工作区隔离 Agent、文件、配置，互不干扰
- **MCP 支持** — 可调用外部 MCP 服务扩展能力
- **Tools (Function Call)** — 原生支持 OpenAI 兼容的 Function Calling
- **Skills 系统** — 本地导入技能包，扩展 Agent 能力
- **Hooks** — 生命周期钩子，可在关键节点注入自定义逻辑
- **定时任务** — 支持 cron 表达式，满足 OpenClaw 级别的定时调度能力
- **多 Agent 协作** — 子 Agent 创建、调用、交接、并行汇总
- **独立 Persona** — 每个 Agent 有独立的 system prompt 和人设
- **分层记忆系统** — 短期记忆 + 长期记忆分离，持久化存储到本地文件
- **多租户支持** — 记忆模式支持多租户隔离

## 🏗️ 架构

```
┌─────────────────────────────────┐
│         原生 UI 层               │
│   (Swift / Kotlin / Flutter)    │
├─────────────────────────────────┤
│       gomobile bind 接口层       │
├─────────────────────────────────┤
│           Go 核心层              │
│  ┌───────┐ ┌───────┐ ┌───────┐ │
│  │ Agent │ │ LLM   │ │Memory │ │
│  │ Engine│ │ Router│ │ Store │ │
│  └───────┘ └───────┘ └───────┘ │
│  ┌───────┐ ┌───────┐ ┌───────┐ │
│  │ Tools │ │ Skills│ │ Hooks │ │
│  └───────┘ └───────┘ └───────┘ │
│  ┌───────┐ ┌───────┐ ┌───────┐ │
│  │  MCP  │ │ Cron  │ │Workspace│ │
│  └───────┘ └───────┘ └───────┘ │
└─────────────────────────────────┘
```

- **Go 核心**：只负责逻辑处理，不碰 UI
- **gomobile bind**：生成 `.aar`(Android) + `.xcframework`(iOS)，暴露简单类型接口
- **原生 UI**：Swift 写 iOS，Kotlin 写 Android，体验原生

## 🎯 目标用户

- 希望在本地拥有智能终端的开发者
- 需要在手机上运行 AI Agent 的用户
- 不想依赖云服务、注重隐私的用户

## 🚀 快速开始

```bash
go get github.com/tietiezhi-1216/tietiezhi
```

## 📋 MVP 范围

- [ ] LLM 多厂商接入 + 流式输出
- [ ] 本地/远程工作区
- [ ] MCP 调用
- [ ] Tools (Function Call)
- [ ] Skills 本地导入
- [ ] Hooks 生命周期钩子
- [ ] 定时任务（cron）
- [ ] 多 Agent 协作（创建/调用/交接/并行）
- [ ] 分层记忆系统（短期 + 长期）

## 📄 License

MIT
