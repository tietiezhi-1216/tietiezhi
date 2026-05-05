# Tietiezhi（铁铁汁）

> 一个面向飞书群和团队现场的 Agent 项目。中文名叫“铁铁汁”，英文名叫 `Tietiezhi`，平时一般叫它“铁汁”。

“铁汁”来自中国人聊天里那种亲近、熟络、能一起扛事的称呼。Tietiezhi 不是又一个只停留在聊天窗口里的助手。它更像团队群里的一个成员：能接住上下文，记住约定，跟进工作进度，查看代码库和文件，定时提醒，也能把复杂任务拆给子代理继续做。

它可以作为个人 Agent 使用，但更主要的目标是团队 Agent。尤其是在飞书群里，铁汁应该能陪一个团队维护项目日常：需求推进、代码库状态、任务提醒、会议后续、知识沉淀、周期性检查，以及那些没人想每天手动整理但又很重要的事情。

## 想做什么

- 在飞书群里响应团队问题，而不是只服务单人对话。
- 把项目上下文、团队约定、长期记忆沉淀成 Markdown 文件。
- 通过工具读取文件、分析材料、执行命令、访问网页，并把结果带回对话。
- 用定时任务和心跳机制跟进工作进度、提醒待办、触发周期性检查。
- 用子代理处理更长、更分散的任务，比如代码库巡检、资料整理、方案拆解。
- 保持 OpenAI 兼容接口，让不同模型和调用方可以接进来。
- 以一个 YAML 配置启动完整服务，不强迫引入数据库或额外平台。

## 适合的场景

- 飞书项目群里的进度跟进、日报/周报辅助、待办提醒。
- 团队代码库维护，例如让 Agent 阅读仓库文件、总结变更、辅助排查问题。
- 长期项目知识库，把团队规则、决策、复盘和背景信息写进工作区。
- 个人 Agent，把自己的偏好、上下文、资料和自动化任务放在自己的服务中。
- 多 Agent 工作流，把主 Agent 收到的任务拆给子代理异步或同步执行。

## 当前能力

| 模块 | 说明 |
|------|------|
| Server | 提供 `/health`、OpenAI 兼容的 `/v1/chat/completions`、`/v1/models`，并包含管理 API |
| LLM | OpenAI 协议 Provider，支持同步和流式响应，可配置 cheap model |
| Agent | 对话历史、工具调用、循环检测、上下文压缩、审批、Hook、记忆注入 |
| 飞书 | 已有飞书渠道代码，可通过配置启用，并支持流式/非流式模式 |
| Telegram | 已有配置结构和渠道实现，当前启动装配以飞书为重点 |
| 工具 | `terminal_exec`、`file_read`、`file_write`、`file_analyze`、`web_search`、`web_fetch` |
| 记忆 | Markdown 工作区，包含身份、用户、长期记忆、每日笔记和上传目录 |
| 定时任务 | 支持 `at`、`every`、`cron` 三类计划，任务持久化为 JSON |
| 心跳 | 可周期性检查并通过渠道投递结果 |
| 子代理 | 支持同步/异步 spawn、工具白名单、模型选择、会话模式和文件注入 |
| Skills / MCP / Hook | 已有加载、管理和执行框架 |
| 沙箱 | 可选 Docker 沙箱，用于终端工具执行隔离 |

## 快速开始

安装 [Task](https://taskfile.dev/) 后可以直接使用仓库中的 `Taskfile.yml`。

```bash
git clone <repo-url>
cd tietiezhi

task build
task run
```

`task build` 会先构建 WebUI 静态页面，再把页面打包进 `bin/tietiezhi` 这个单二进制。首次启动会在 `~/.tietiezhi/config.yaml` 初始化配置模板。填入 LLM 和渠道配置后再次启动即可；后续 WebUI 也会围绕这个文件做配置读写。

服务默认监听 `0.0.0.0:18178`。启动后检查：

```bash
curl http://localhost:18178/health
```

也可以直接使用 Go 命令：

```bash
go build -o bin/tietiezhi ./cmd/server
./bin/tietiezhi
```

也可以用 `-c` 指定其他配置文件，但运行时文件仍会统一保存在 `~/.tietiezhi/` 下。

## 本地联调

```bash
task dev
```

`task dev` 会同时启动：

- 后端：`http://127.0.0.1:18178`
- 前端 Vite dev server：`http://127.0.0.1:5173`

开发模式下，前端会把 `/health` 和 `/v1/*` 代理到后端。打包模式下，WebUI 由 Go 服务直接从二进制中提供，打开 `http://127.0.0.1:18178/` 即可访问。

## 配置示例

```yaml
server:
  host: "0.0.0.0"
  port: 18178

llm:
  provider: "openai"
  base_url: "https://api.openai.com/v1"
  api_key: "your-api-key"
  model: "gpt-4o"
  cheap_model: ""

agent:
  max_tool_calls: 20
  system_prompt: "你是一个能维护团队进度和项目上下文的 Agent"
  loop_detection: true

channels:
  feishu:
    enabled: false
    app_id: ""
    app_secret: ""
    streaming: false
    bot_open_id: ""
  telegram:
    enabled: false
    bot_token: ""
    admin_ids: []

memory:
  type: "markdown"

scheduler:
  enabled: true
  exec_timeout: 300

heartbeat:
  enabled: true
  interval: 30
  chat_id: ""
```

完整配置模板由服务首次启动时写入 `~/.tietiezhi/config.yaml`。

## 飞书群里的使用方向

铁汁的核心使用场景不是“问一句答一句”，而是长期留在团队群里做上下文维护：

- 记录项目关键决策和进展，沉淀到 Markdown 记忆。
- 定时检查某些任务是否推进，必要时在群里提醒。
- 帮团队整理会议后续、风险点、负责人和下一步动作。
- 读取代码库或工作区文件，回答“现在这个项目到哪了”。
- 通过子代理并行处理多个检查项，再把结果汇总回主会话。
- 用 Hook、MCP、Skills 把团队已有工具逐步接进来。

## 项目结构

```text
tietiezhi/
├── cmd/server/           # 服务入口
├── internal/
│   ├── agent/            # Agent 主循环、工具调用、压缩、审批、循环检测
│   ├── channel/          # 渠道抽象与飞书、Telegram 等实现
│   ├── config/           # YAML 配置结构、默认值、模板初始化和本地目录派生
│   ├── cron/             # 定时任务管理
│   ├── heartbeat/        # 心跳检查
│   ├── hook/             # Hook 事件和规则
│   ├── llm/              # LLM Provider 和 OpenAI 协议实现
│   ├── mcp/              # MCP 管理
│   ├── media/            # 上传和媒体处理
│   ├── memory/           # Markdown 记忆系统
│   ├── sandbox/          # Docker 沙箱
│   ├── server/           # HTTP API 和管理 API
│   ├── session/          # 会话历史和持久化
│   ├── skill/            # Skills 加载
│   ├── subagent/         # 子代理管理
│   ├── tool/             # 工具接口和内置工具
│   └── webui/            # 嵌入到 Go 二进制中的 WebUI 静态文件
├── web/                  # SvelteKit + Tailwind CSS + shadcn-svelte WebUI
├── Taskfile.yml          # 构建、运行、测试命令
└── AGENTS.md             # 给开发代理的项目说明
```

## 开发命令

```bash
task dev           # 前后端联调
task build         # 构建 WebUI 并编译单二进制 bin/tietiezhi
task build:server  # 仅编译 Go 服务端
task run           # 构建单二进制并使用 ~/.tietiezhi/config.yaml 启动
task web:dev       # 仅启动 WebUI 开发服务
task web:build     # 仅构建 WebUI 静态文件并同步到 Go embed 目录
task web:check     # 检查 WebUI 类型和 Svelte 语法
task test          # go test ./...
task lint          # go vet ./...
task tidy          # go mod tidy
task clean         # 删除 bin/ 和前端构建产物
```

## 开发说明

开发规范和项目边界请看 [AGENTS.md](AGENTS.md)。后续改动如果涉及配置结构，请同步更新 `internal/config/config.go` 中的默认配置模板。

## License

MIT
