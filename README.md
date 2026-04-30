# tietiezhi

> 🇨🇳 轻量级本地 AI Agent 框架 — 一个配置文件搞定所有功能

tietiezhi 是一个用 Go 开发的轻量级 AI Agent 框架，聚焦 **Server 模式**，将市面上所有 Agent 功能整合到一个好配置、好使用、好管理的服务中。

## 为什么做 tietiezhi？

市面上有很多 Agent 框架，但它们要么太重（需要数据库、Redis），要么功能碎片化（只做渠道、只做工具、只做记忆），要么配置复杂（交互式引导、多层嵌套配置）。

tietiezhi 的定位很明确：

- **功能全**：渠道、Agent、Hook、定时任务、Skills、MCP、记忆、LLM — 全都整合在一个服务里
- **配置简**：一个 YAML 文件搞定，不搞交互式引导，不搞多余代码
- **零依赖**：零数据库，Markdown 驱动的记忆系统，单二进制部署
- **协议通**：原生支持 OpenAI 协议，兼容主流大模型

## 核心特性

| 特性 | 说明 |
|------|------|
| 🎯 配置驱动 | 一个 YAML 文件搞定所有功能，清晰明了 |
| 🔌 OpenAI 协议 | 原生支持，兼容 OpenAI / Azure / 国产模型 |
| 📦 零数据库 | Markdown 文件记忆，SOUL.md / MEMORY.md / USER.md |
| 🚀 开箱即用 | 单二进制部署，无外部依赖 |
| 📡 多渠道 | 飞书、钉钉、Telegram、Discord... |
| 🛠️ 工具系统 | 内置工具 + 技能包（Anthropic MD 规范）+ MCP 协议 |
| 🪝 Hook 链 | LLM 调用前后、工具调用前后、消息收发前后 |
| ⏰ 定时任务 | Cron 表达式驱动，定时执行任务 |
| 🔄 循环检测 | 多策略检测工具调用循环，防止 Agent 陷入死循环 |
| 🇨🇳 中文优先 | 文档、配置、注释全中文 |

## 功能状态

- ✅ YAML 配置驱动
- ✅ 项目骨架与核心接口
- 🔄 LLM 接入（OpenAI 协议，含流式）
- 🔄 Agent 对话引擎（单轮 / 多轮 / 工具调用循环）
- 🔄 工具调用循环检测
- 📋 渠道接入（飞书、钉钉、Telegram、Discord、Slack）
- 📋 技能包系统（Anthropic MD 规范）
- 📋 Hook 系统（6 个核心触发点）
- 📋 MCP 协议支持
- 📋 Markdown 记忆系统
- 📋 定时任务调度
- 📋 工作区管理

## 快速开始

```bash
# 克隆项目
git clone https://github.com/tietiezhi-1216/tietiezhi.git
cd tietiezhi

# 配置
cp configs/config.example.yaml configs/config.yaml
# 编辑 config.yaml，填入你的 API Key

# 构建并运行
task build && task run
```

服务启动后访问 `http://localhost:8080/health` 检查状态。

## 配置示例

```yaml
server:
  host: "0.0.0.0"
  port: 8080

llm:
  provider: "openai"
  base_url: "https://api.openai.com/v1"
  api_key: "sk-your-api-key"
  model: "gpt-4o"

agent:
  max_tool_calls: 20
  system_prompt: "你是一个有用的AI助手"
  loop_detection: true

channels:
  feishu:
    enabled: false
    app_id: ""
    app_secret: ""

memory:
  type: "markdown"
  path: "./workspaces"

skills:
  path: "./skills"
```

完整配置参考 [configs/config.example.yaml](configs/config.example.yaml)。

## 项目结构

```
tietiezhi/
├── cmd/server/           # 入口
├── internal/
│   ├── config/           # 配置加载
│   ├── server/           # HTTP 服务
│   ├── llm/              # LLM 接入层
│   ├── agent/            # Agent 引擎 + 循环检测
│   ├── channel/          # 渠道层
│   │   └── feishu/       # 飞书渠道
│   ├── tool/             # 工具系统
│   │   └── builtin/      # 内置工具
│   ├── skill/            # 技能包（Anthropic MD 规范）
│   ├── hook/             # Hook 链
│   ├── mcp/              # MCP 协议
│   ├── memory/           # 记忆系统
│   ├── scheduler/        # 定时任务
│   └── workspace/        # 工作区管理
├── configs/              # 配置文件
├── skills/               # 技能包目录
├── workspaces/           # 工作区目录
├── AGENTS.md             # 开发规范
└── Makefile              # 构建命令
```

## 开发计划

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 配置加载 + LLM 接入（OpenAI） + 单轮对话 + HTTP API | 🔄 |
| Phase 2 | Agent 多轮对话 + 工具调用 + 循环检测 | 📋 |
| Phase 3 | 渠道接入（飞书） | 📋 |
| Phase 4 | 技能包 + Hook 系统 | 📋 |
| Phase 5 | MCP 协议 + 记忆系统 | 📋 |
| Phase 6 | 定时任务 + 工作区管理 | 📋 |
| Phase 7 | 打磨优化 + 文档完善 | 📋 |

## 开发规范

详见 [AGENTS.md](AGENTS.md)。

## 贡献

欢迎 PR！请先阅读 [AGENTS.md](AGENTS.md) 了解开发规范。

## License

MIT
