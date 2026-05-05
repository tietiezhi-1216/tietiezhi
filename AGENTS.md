# AGENTS.md

本文件是 tietiezhi 项目的开发代理指南。请只以当前仓库中的代码、配置和文档为准；如果 README 与代码不一致，优先相信代码和 `Taskfile.yml`。

## 项目定位

tietiezhi 是一个用 Go 编写的轻量级本地 AI Agent 框架，主要以 Server 模式运行。它提供 OpenAI 兼容接口、渠道接入、内置工具、Skills、MCP、Hook、Markdown 记忆、定时任务、心跳、子代理、会话持久化和可选 Docker 沙箱。

服务入口是 `cmd/server/main.go`，默认配置文件路径是 `~/.tietiezhi/config.yaml`。配置模板内置在 `internal/config/config.go`，真实配置可能包含密钥，不要提交。

## 常用命令

优先使用 `task` 中已有命令：

```bash
task build
task run
task dev
task test
task lint
task tidy
task clean
```

等价底层命令：

```bash
go build -o bin/tietiezhi ./cmd/server
go test ./...
go vet ./...
go mod tidy
```

本项目使用 `go.mod` 中声明的 Go 版本。提交 Go 代码前运行 `gofmt`，涉及依赖时运行 `go mod tidy`。

## 本地运行

1. 首次运行会自动初始化 `~/.tietiezhi/config.yaml`。

2. 填写 `llm.api_key`、`llm.base_url`、`llm.model` 等必要配置。后续也可以通过管理 API 或 WebUI 修改配置。

3. 运行：

   ```bash
   task run
   ```

4. 健康检查：

   ```bash
   curl http://localhost:18178/health
   ```

配置中的默认端口是 `18178`。README 中出现的端口或 Makefile 描述如果与代码不一致，以 `internal/config/config.go` 和 `Taskfile.yml` 为准。

## 目录结构

- `cmd/server/`: 服务启动入口，负责装配配置、LLM、Agent、工具、渠道、管理 API 和生命周期。
- `internal/config/`: YAML 配置结构、默认值、默认配置初始化和本地目录派生。
- `internal/server/`: OpenAI 兼容 HTTP API 与管理 API。
- `internal/llm/`: LLM 抽象与 OpenAI 协议实现。
- `internal/agent/`: Agent 主循环、工具调用、循环检测、上下文压缩、审批、技能和子代理编排。
- `internal/tool/`: 通用工具接口与注册表。
- `internal/tool/builtin/`: 内置工具，包括 `terminal_exec`、`file_read`、`file_write`、`file_analyze`、`web_search`、`web_fetch`。
- `internal/channel/`: 渠道抽象与渠道实现，目前包含飞书、Telegram、HTTP 相关代码。
- `internal/memory/`: Markdown 工作区记忆系统，会生成 `AGENTS.md`、`SOUL.md`、`USER.md`、`MEMORY.md`、每日笔记和上传目录。
- `internal/skill/`: Anthropic Markdown 风格技能加载与解析。
- `internal/mcp/`: MCP 客户端管理。
- `internal/hook/`: Hook 事件、规则和内置脚本。
- `internal/cron/`: 定时任务存储、调度和 Agent 执行。
- `internal/heartbeat/`: 心跳检查与投递。
- `internal/subagent/`: 子代理 spawn、同步/异步执行与持久化记录。
- `internal/session/`: 会话历史和自动保存。
- `internal/media/`: 上传文件与媒体处理。
- `internal/sandbox/`: Docker 沙箱执行支持。
- `internal/webui/`: 嵌入到 Go 二进制中的 WebUI 静态文件，`dist/` 内容由 `task web:build` 生成。
- `web/`: SvelteKit + Tailwind CSS + shadcn-svelte 前端 WebUI 项目。

## 配置与路径约定

- `config.Load` 会在配置文件不存在时初始化 YAML 模板，并把运行时文件统一派生到 `~/.tietiezhi/` 下。
- YAML 中不暴露 path 配置；`memory`、`skills`、`scheduler`、`session`、`subagent`、审计日志、文件工具目录和沙箱挂载都由 `internal/config` 统一决定。
- 文件读写工具默认只允许访问 `~/.tietiezhi/workspace`。
- `sandbox.enabled` 为 true 时会检查 Docker 和镜像；不可用时会降级为禁用沙箱。
- `llm.provider` 当前只支持 `openai`，但实现是 OpenAI 协议兼容，不限定具体供应商。

## 开发原则

- 保持单二进制、零数据库的设计取向。新增持久化能力时优先考虑现有 JSON/Markdown 文件存储模式。
- 保持配置驱动。新增功能应在 `internal/config/config.go` 增加结构、默认值和内置配置模板。
- 新增 HTTP 能力时优先放在 `internal/server/management.go` 或 `internal/server/server.go` 的现有路由体系里。
- 新增工具时实现 `internal/tool.Tool` 接口，并在内置工具注册或 Agent 工具列表构建处接入。
- 新增渠道时实现 `internal/channel.Channel`，并在启动入口按配置注册。
- 需要跨包交互时优先使用小接口，延续现有 `cron`、`subagent` 等包的依赖方式，避免引入循环依赖。
- 不要把密钥、真实配置、运行时数据、会话、上传文件或构建产物提交到仓库。

## Go 代码风格

- 使用标准库优先，避免为小功能引入新依赖。
- 错误信息和日志目前以中文为主，新增代码保持一致。
- 公共类型和导出函数保留简洁中文注释，符合 Go 文档习惯。
- 结构体字段使用明确的 `json` 或 `yaml` tag；配置字段要同步更新示例配置。
- HTTP handler 要校验方法、请求体和必填字段，返回合理状态码。
- 长时间运行或外部调用要接收并传递 `context.Context`。
- goroutine 中执行外部任务时注意超时、错误日志和资源释放。
- 不要吞掉关键错误；如果兼容旧行为需要降级，记录清楚日志。

## 功能边界提示

- Agent 主流程在 `BaseAgent.Run`、`RunStream` 和内部 `runWithTools` 附近，改动前先确认工具循环、Hook、记忆注入、压缩和会话历史的顺序。
- 记忆系统会自动初始化工作区默认文件。修改默认内容时确认 `BuildMemoryContext` 的注入顺序和群聊隐私规则。
- 定时任务支持 `at`、`every`、`cron` 三类 schedule，`cron` 输入是 5 位表达式，内部转换为带秒的表达式。
- 子代理支持工具白名单、cheap 模型、system prompt 覆盖、同步/异步和 ephemeral/persistent 会话模式。
- 文件和终端工具有安全边界；改动时不要放宽默认限制，除非配置明确要求。
- 管理 API 会掩码返回 API key；新增敏感字段时也要做类似处理。

## 测试与验证

当前仓库没有 `_test.go` 文件。新增或修改行为逻辑时，请优先补充聚焦的单元测试，尤其是：

- 配置默认值和路径解析。
- 工具参数校验与安全限制。
- Agent 工具循环、循环检测、压缩和审批。
- HTTP handler 的方法、状态码和响应结构。
- Cron schedule 解析和持久化。
- Markdown 记忆读写和群聊隐私边界。

提交前至少运行：

```bash
task test
task lint
```

文档或注释-only 变更可不运行完整测试，但应说明未运行原因。

## 提交规范

- 任何代码、配置或文档修改完成后都需要创建 Git commit；除非用户明确要求暂不提交，或仓库状态存在无法安全提交的未解决冲突。
- 提交前先确认 `git status`，只提交本次任务相关文件，不要把无关未提交改动、真实配置、密钥或运行时数据混入提交。
- 提交信息使用 Conventional Commits 风格：`type(scope): summary` 或 `type: summary`，例如 `feat(config): 统一本地配置目录`、`fix(server): 修复配置保存错误`、`docs: 添加提交规范`。
- 常用类型包括 `feat`、`fix`、`docs`、`refactor`、`test`、`chore`；summary 使用简洁中文，说明本次提交的实际效果。

## 前端 WebUI

- `web/` 是 SvelteKit + Tailwind CSS + shadcn-svelte 前端项目，使用 pnpm 管理依赖。
- shadcn-svelte 官方 LLM 参考文件应保存在 `web/docs/shadcn-svelte-llms.txt`；开发 `web/` 时可以先参考该文件了解组件、CLI 和文档入口。
- 前端开发优先使用官方 CLI：`pnpm dlx sv create ... --add tailwindcss`、`pnpm dlx shadcn-svelte@latest init` 和 `pnpm dlx shadcn-svelte@latest add <component>`。
- 本地联调用 `task dev`，会同时启动后端 `18178` 和前端 Vite `5173`；Vite 会把 `/health` 和 `/v1/*` 代理到后端。
- 单二进制构建用 `task build`，它会运行 WebUI 静态构建并同步到 `internal/webui/dist`，随后由 `go:embed` 打进 `bin/tietiezhi`。
- 前端验证命令优先使用 Task：`task web:check`、`task web:build`；直接在 `web/` 下也可运行 `pnpm check`、`pnpm build`。

## 文件安全

- `~/.tietiezhi/config.yaml`、`.tietiezhi/`、`data/`、`bin/`、`web/build/`、`internal/webui/dist/` 中的生成文件、日志文件和系统临时文件都应保持忽略或位于仓库外。
- 不要把真实 LLM key、飞书/Telegram token、MCP 凭证或用户记忆写入仓库文件。
- 对用户工作区文件做写入功能时，默认使用可恢复、可审计的方式；危险操作需要明确配置或用户确认。

## 给后续代理的工作方式

- 先读相关代码再改，不要只根据 README 或计划表判断实现状态。
- 小步修改，保持包边界清晰。
- 修改配置结构时同步更新 `internal/config/config.go` 的默认配置模板和相关启动装配。
- 修改可观测行为时更新 README 或本文件中对应说明。
- 遇到已有未提交改动时，先判断是否与任务相关；不要回滚无关改动。
