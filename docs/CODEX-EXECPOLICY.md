# Codex ExecPolicy

## 范围

R18 将固定上游 `rust-v0.145.0` 的 Starlark ExecPolicy、绝对路径不变量、Bash 语法树解析、PowerShell AST 解析和安全命令分类源码移植到本地 Runtime。

- `crates/agent-absolute-path` 保证规则中的可执行文件路径绝对且规范化。
- `crates/agent-shell-command` 解析 Shell wrapper、管道、组合命令、引用、重定向和 PowerShell 命令。
- `crates/agent-execpolicy` 实现 `prefix_rule`、`host_executable`、`network_rule`、示例校验、规则覆盖和修订写入。
- `agent-tools` 在创建进程前执行策略，输出 `allow`、`prompt` 或 `forbidden`。

## 规则语义

- `prefix_rule` 支持固定 Token 和备选 Token，按真实 argv 匹配，不做字符串包含判断。
- 同一命令匹配多个规则时使用最严格结果：`forbidden > prompt > allow`。
- 管道和组合命令逐段检查，整条命令采用最严格结果。
- 绝对可执行文件只有在 `host_executable` 声明的路径内才能回退到 basename 规则。
- `match` 和 `not_match` 示例在加载规则时验证，错误规则不会静默生效。
- 不能可靠解析的 Shell 构造保持保守，不从复杂 heredoc、替换或动态表达式生成永久允许建议。

## 审批与沙箱

- `untrusted` 仅让已知只读命令跳过审批，未知或写命令请求审批。
- `on-request` 让普通命令在受限沙箱内执行；危险命令、显式提权或规则要求仍请求审批。
- `never` 不弹窗：普通命令依赖沙箱，危险或规则要求审批的命令直接拒绝。
- `granular` 分别尊重 rules 和 sandbox approval 开关。
- 显式 allow 规则可以按 Codex 语义绕过沙箱；其他 allow 仍在当前沙箱中运行。
- forbidden 在审批请求和进程创建前终止，没有“仍然运行”的旁路。

## 持久修订

- `acceptWithExecpolicyAmendment` 立即更新内存策略。
- 同一修订写入应用数据目录 `agent-runtime/rules/default.rules`。
- 迁移期同时写入 `approval-rules.json`，保证 R14 旧记录可读取；R38 删除兼容镜像。
- Shell、解释器、`sudo`、`rm` 等过宽前缀不会作为自动永久允许建议。

## 验证

- 固定上游绝对路径测试 26 项。
- 固定上游 Shell 与安全分类测试 141 项。
- Starlark、修订和迁移测试覆盖规则语法与原子追加。
- Runtime 测试覆盖优先级、管道、引用、host executable、`never`、只读命令和修订建议。
- Unified Exec 测试覆盖 prompt 精确修订和 forbidden 不创建进程。
- macOS、Windows CI 均编译并运行策略、Shell 和桌面集成测试。
