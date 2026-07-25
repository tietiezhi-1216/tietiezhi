# Codex 审批策略

## 范围

R14 在源码级 Runtime 中实现 Codex 的 Approval Policy 和反向 JSON-RPC，不运行或嵌入上游二进制。

- 策略：`untrusted`、`on-request`、`never`、`granular`。
- Granular 分类：sandbox、rules、skill、request permissions、MCP elicitation。
- V2 请求：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。
- 兼容请求：`execCommandApproval`、`applyPatchApproval`。
- 目录请求：`permissionProfile/list`。
- 模型工具：`request_permissions`。

## 策略阶段

审批策略和技术隔离是两个独立层：

- `untrusted` 只自动通过由 ExecPolicy 判定为可信只读的命令，其余操作询问用户。
- `on-request` 在受限或尚不可用的沙箱需要升级时询问；外部沙箱和 unrestricted profile 不额外询问。
- `never` 不显示审批，操作只能在既有权限中执行，失败直接返回模型。
- `granular` 为 sandbox、规则、Skill、权限请求和 MCP elicitation 分别决定是否允许显示审批；关闭的类别直接拒绝，不静默扩大权限。
- R15/R16 接入真实平台沙箱后会把当前 `Unavailable` 能力替换为真实 `Restricted/External/Unrestricted` 判定。
- R18 的 ExecPolicy 负责可信只读分类和命令规则；R14 不使用字符串黑名单模拟安全解析。

## 授权作用域

“本作用域允许”仅写入内存中的 Thread 会话缓存：

- 命令键包含环境、完整命令、cwd、TTY、sandbox permissions 和 additional permissions。
- Patch 为每个目标绝对路径建立独立键；已批准集合的子集可复用，新增路径必须重新询问。
- 权限请求键包含环境、cwd 和完整权限 Profile。
- MCP 与网络键已定义为 server/tool/arguments 和 scheme/host/port/action，分别由 R19、R17 接入。
- Thread archive/delete 会清理该 Thread 的缓存；缓存从不写盘，也不会跨 Thread 复用。

“应用规则”与会话缓存完全分离：

- `acceptWithExecpolicyAmendment` 写入 `agent-runtime/approval-rules.json` 的 ExecPolicy 规则区。
- `applyNetworkPolicyAmendment` 写入同一版本化文件的 Network Policy 规则区。
- 文件采用临时文件替换和去重写入；R17/R18 只消费对应规则类型。
- `accept` 不缓存；`decline` 只拒绝当前操作并继续 Turn；`cancel` 才取消 Turn。

## 权限 Profile

`permissionProfile/list` 使用与固定 Codex 版本相同的数字 cursor 和分页规则，当前公开三个内建 Profile：

- `:read-only`
- `:workspace`
- `:danger-full-access`

`request_permissions` 接受 filesystem/network Profile，向订阅该 Thread 的客户端发送 V2 反向请求，并支持 `turn` 或 `session` grant scope。R15/R17 将 granted profile 应用到实际文件和网络隔离。

## 客户端

`CodexApprovalPrompt` 对新旧命令、文件和权限请求生成对应的 V2 Response：

- 允许一次
- 本作用域允许
- 拒绝并继续
- 停止任务

权限请求的允许响应原样返回客户端选择的 Profile 和 `turn/session` scope；拒绝和取消使用 JSON-RPC error，不伪造空权限为成功授权。

## 验证

- 四种策略和五种 granular 分类。
- restricted、external、unrestricted、unavailable 沙箱能力判定。
- 命令 cwd 隔离、Patch 子集复用和跨 Thread 隔离。
- 持久 Amendment 原子写入、去重和重启读取。
- 新旧命令/文件审批的全部决策。
- 权限请求 V2 Schema、scope 默认值和模型工具结果。
- Permission Profile cursor/limit。
- 审批卡片 SSR 和 TypeScript 严格类型检查。
