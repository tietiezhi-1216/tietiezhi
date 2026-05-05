# tietiezhi AGENTS.md

本文件是 coding agent 的项目操作手册。README 面向人类读者，AGENTS.md 面向自动化编码代理；这里写代理执行任务时必须遵守的架构、编码、测试和提交流程。

## 适用范围与优先级

- 根目录 `AGENTS.md` 适用于整个仓库。
- 如子目录存在更近的 `AGENTS.md` 或 `AGENTS.override.md`，以更近文件的规则为准。
- 用户在当前对话中的明确要求优先于本文件。
- 指令必须具体、可执行、可验证；避免写泛泛的价值观口号。
- 文件使用标准 Markdown，不需要 front matter。

## 项目定位

- tietiezhi 是配置驱动的 Agent 服务。
- 功能通过 YAML 配置开启或关闭，不做交互式引导。
- 记忆使用 Markdown 文件，配置使用 YAML 文件，不引入数据库。
- 文档、注释、配置以中文优先。

## 工作方式

- 实现前先确认任务目标、影响范围和验收方式。
- 存在多种合理解释、破坏性操作或高风险变更时，先向用户说明并确认。
- 优先选择能解决当前问题的最小实现，不添加未被要求的功能、抽象或可配置项。
- 只修改与当前任务直接相关的代码；发现无关问题可以说明，不主动重构或删除。
- 匹配现有代码风格，即使可以用另一种方式写得更漂亮。
- 多步骤任务先给简短计划，并为每一步写清验证方式。
- 修 bug 时优先写能复现问题的测试，再修复并让测试通过。

## 核心原则

- **配置驱动**：所有功能通过 YAML 配置开启或关闭。
- **接口优先**：先定义接口，再实现；消费方定义接口。
- **扁平目录**：包不嵌套超过 2 层。
- **依赖单向**：保持 `channel → agent → llm` 等单向依赖，不交叉引用。
- **零数据库**：记忆用 Markdown 文件，配置用 YAML 文件。
- **中文优先**：文档、注释、配置全中文。

## 目录结构

```text
tietiezhi/
├── cmd/server/           # 入口，加载配置 → 启动 Server
├── internal/
│   ├── config/           # YAML 配置加载与校验
│   ├── server/           # HTTP Server，路由注册
│   ├── llm/              # LLM Provider 接口 + OpenAI 实现
│   ├── agent/            # Agent 核心 + 循环检测
│   ├── channel/          # Channel 接口 + 各渠道实现
│   │   └── feishu/       # 飞书渠道
│   ├── tool/             # Tool 接口 + 注册表
│   │   └── builtin/      # 内置工具
│   ├── skill/            # Skill 加载器（Anthropic MD 规范）
│   ├── hook/             # Hook 接口 + 执行链
│   ├── mcp/              # MCP 协议客户端
│   ├── memory/           # Memory 接口 + Markdown 实现
│   ├── scheduler/        # 定时任务调度
│   └── workspace/        # 工作区管理
├── configs/              # 配置文件
├── skills/               # 技能包目录
└── workspaces/           # 工作区目录
```

## 依赖方向

```text
server → agent → llm
              → tool
              → memory
       → channel → agent
       → scheduler → agent
```

- `channel` 依赖 `agent`，负责将外部消息转发给 Agent 处理。
- `agent` 不依赖 `channel`，避免渠道逻辑污染核心流程。
- `server` 负责组装配置、注册路由、启动服务，不承载业务细节。
- 新增依赖前先检查是否会破坏现有单向依赖。

## 核心接口

```go
// Provider 定义 LLM 提供者能力。
type Provider interface {
    Chat(ctx, req) (*ChatResponse, error)
    ChatStream(ctx, req) (<-chan StreamChunk, error)
}

// Agent 定义智能体执行入口。
type Agent interface {
    Run(ctx, input) (*Message, error)
}

// Channel 定义外部渠道生命周期与消息发送能力。
type Channel interface {
    ID() string
    Start(ctx) error
    Stop(ctx) error
    Send(ctx, channelID, msg) error
}

// Tool 定义工具元信息与执行能力。
type Tool interface {
    Name() string
    Description() string
    Parameters() any
    Execute(input) (string, error)
}

// Memory 定义记忆读取、写入和搜索能力。
type Memory interface {
    Load(ctx, key) (string, error)
    Save(ctx, key, content) error
    Search(ctx, query) ([]string, error)
}

// Hook 定义扩展点执行能力。
type Hook interface {
    Name() string
    Point() HookPoint
    Execute(ctx, data) (any, error)
}
```

## 代码规范

- 每个函数写一行中文注释说明职责。
- 长函数按步骤分段，必要时加过程日志。
- 不封装只转调一行的函数。
- 不添加当前任务之外的功能。
- 不做 speculative abstraction，不为未来可能性提前设计。
- 只清理本次修改造成的无用 import、变量、函数或测试夹具。
- 不主动删除或重构任务无关的历史代码。
- HTTP 路由使用标准库 `net/http`，不用第三方路由库。
- Go 代码变更后运行 `gofmt`。

## 配置规范

- 配置格式使用 YAML。
- 配置注释使用中文。
- 本地配置文件路径为 `configs/config.yaml`，该文件由 `.gitignore` 忽略。
- 示例配置文件为 `configs/config.example.yaml`，需要提交到仓库。
- 配置加载和默认值填充放在 `internal/config/config.go`。
- 新功能必须先设计配置项，再实现功能逻辑。

## 记忆系统规范

- 记忆类型为 Markdown 文件。
- 记忆文件包括 `SOUL.md`、`MEMORY.md`、`USER.md`。
- 记忆目录为 `workspaces/{workspace-id}/`。
- 记忆接口只暴露 `Load`、`Save`、`Search`。
- 不为记忆系统引入数据库。

## 技能包规范

- 技能包遵循 Anthropic MD 文件规范。
- 技能包结构为 `skill-name/SKILL.md`、`references/`、`scripts/`。
- 技能加载器放在 `internal/skill/loader.go`。
- 技能内容优先中文，命令和代码标识保持原文。

## 测试与验收

- 涉及 Go 代码变更后必须运行 `go test ./...`。
- 仅文档变更可运行 `git diff --check` 验证格式，并在最终回复说明未运行 Go 测试的原因。
- 修复 bug 时新增或更新能覆盖问题的测试。
- 新增接口、配置或行为时补充对应测试或说明无法测试的原因。
- 测试失败时先判断是否由本次修改引入；只修复与任务相关的失败。
- 完成前检查 diff，确保每一处改动都能对应到用户需求。

## 提交规范

- 提交信息使用英文。
- 格式为 `type(scope): message`。
- `type` 可选：`feat`、`fix`、`refactor`、`docs`、`test`、`chore`。
- `scope` 使用模块名，例如 `llm`、`agent`、`config`。
- 示例：`feat(llm): implement OpenAI streaming response`

## AGENTS 文档维护规范

- 优先把稳定、长期有效的项目规则写入本文件。
- 临时任务要求留在对话里，不写入 AGENTS.md。
- 新增章节时按这个顺序组织：项目定位、工作方式、架构约束、目录结构、编码规范、模块规范、测试验收、提交规范。
- 每条规则尽量包含明确路径、命令或判断标准。
- 避免写“保持高质量”“注意安全”这类不可验证描述，改成具体动作。
- 文件过长时按子目录拆分更近的 `AGENTS.md`，不要让根文件承载所有细节。
