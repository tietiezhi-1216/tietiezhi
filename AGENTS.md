# tietiezhi 开发规范

## 核心原则

- **配置驱动**：所有功能通过 YAML 配置开启/关闭，不搞交互式引导
- **接口优先**：先定义接口，再实现，消费方定义接口
- **扁平目录**：包不嵌套超过 2 层，依赖单向（channel → agent → llm）
- **零数据库**：记忆用 Markdown 文件，配置用 YAML 文件
- **中文优先**：文档、注释、配置全中文

## 代码规范

- 每个函数写一行注释说明职责
- 长函数按步骤分段，必要时加过程日志
- 不封装"只转调一行"的函数
- 只处理当前任务相关，不动他人代码
- 跑 `go test ./...` 确保通过
- 不用第三方路由库，用标准库 `net/http`

## 目录结构

```
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

## 核心接口

```go
// LLM 提供者
type Provider interface {
    Chat(ctx, req) (*ChatResponse, error)
    ChatStream(ctx, req) (<-chan StreamChunk, error)
}

// Agent
type Agent interface {
    Run(ctx, input) (*Message, error)
}

// 渠道
type Channel interface {
    ID() string
    Start(ctx) error
    Stop(ctx) error
    Send(ctx, channelID, msg) error
}

// 工具
type Tool interface {
    Name() string
    Description() string
    Parameters() any
    Execute(input) (string, error)
}

// 记忆
type Memory interface {
    Load(ctx, key) (string, error)
    Save(ctx, key, content) error
    Search(ctx, query) ([]string, error)
}

// Hook
type Hook interface {
    Name() string
    Point() HookPoint
    Execute(ctx, data) (any, error)
}
```

## 依赖方向

```
server → agent → llm
              → tool
              → memory
       → channel → agent
       → scheduler → agent
```

依赖单向，不交叉引用。channel 依赖 agent（将消息转发给 agent 处理），agent 不依赖 channel。

## 配置文件规范

- 格式：YAML
- 注释：中文
- 路径：configs/config.yaml（.gitignore 忽略，config.example.yaml 提交）
- 加载：`internal/config/config.go`，带默认值填充

## 记忆系统规范

- 类型：Markdown 文件
- 文件：SOUL.md（灵魂/设定）、MEMORY.md（长期记忆）、USER.md（用户信息）
- 目录：workspaces/{workspace-id}/ 下
- 接口：Load / Save / Search

## 技能包规范

- 遵循 Anthropic MD 文件规范
- 结构：skill-name/SKILL.md + references/ + scripts/
- 加载器：internal/skill/loader.go

## 提交规范

- 提交信息用英文，格式：`type(scope): message`
- type: feat / fix / refactor / docs / test / chore
- scope: 模块名
- 示例：`feat(llm): 实现 OpenAI 流式响应`
