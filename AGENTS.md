# tietiezhi 开发规范

## 核心原则

- Go 只做核心后端：agent / llm / memory / tools / channels / security / api
- 对外接口只导出简单类型：string, int, bool, []byte, struct（规避 gomobile 类型限制）
- 完全本地化，暂不做线上功能（无线上 Skills 市场、无云同步）

## 代码规范

- 每个函数写一行注释说明职责
- 长函数按步骤分段，必要时加过程日志
- 不封装"只转调一行"的函数
- 只处理当前任务相关，不动他人代码
- 跑 `go test ./...` 确保通过

## 模块划分

- `agent/` — Agent 引擎（创建、调度、协作）
- `llm/` — LLM 接入层（多厂商、流式）
- `memory/` — 记忆系统（短期/长期/向量检索）
- `tools/` — Function Call 工具注册与执行
- `skills/` — Skills 加载与运行
- `hooks/` — 生命周期钩子
- `mcp/` — MCP 协议客户端
- `cron/` — 定时任务调度
- `workspace/` — 工作区管理
- `channels/` — 多租户 / 多渠道
- `security/` — 安全与权限
- `api/` — gomobile bind 导出接口

## 提交规范

- 提交信息用英文，格式：`type(scope): message`
- type: feat / fix / refactor / docs / test / chore
- scope: 模块名
