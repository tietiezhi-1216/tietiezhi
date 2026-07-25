# Codex Windows Sandbox

## 范围

R16 在仓库源码中实现 Windows Restricted Token 沙箱，不下载、运行或打包 Codex 二进制。桌面程序和测试 runner 都从自身源码构建的可执行文件重新进入 wrapper，随后创建受限子进程。

- `CreateRestrictedToken` 使用 `DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED`。
- 路径能力使用稳定、路径隔离的 capability SID。
- 工作区和显式可写根通过 ACL 授权，`.git`、`.agents`、`.codex` 始终拒绝写入。
- 原用户目录中与 cwd、可写根和 `PATH` 无关的普通目录拒绝读取。
- junction、symlink 和 reparse point 不被跟随或改写。
- 创建进程时先挂入 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job，再恢复主线程。
- Pipe 与 ConPTY 共用相同 wrapper、Token、ACL 和 Job 生命周期。

## 世界可写审计

启动准备检查 cwd、临时目录、用户目录、公共目录、`PATH` 和系统根的 ACL：

- 同时识别文件写权限和 `GENERIC_WRITE`。
- 工作区外的 Everyone 可写目录为 capability SID 增加显式拒绝。
- 审计限制为 2 秒、50,000 项和每目录 1,000 项，超限或读取失败通过 `windows/worldWritableWarning` 报告。
- 审计与 ACL 准备按策略和环境缓存；失败会清理缓存，下一次调用重新执行，不会把失败视为已准备。

## App Server V2

- `windowsSandbox/readiness` 在 Windows 返回 `ready`，其他平台返回 `notConfigured`。
- `windowsSandbox/setupStart` 执行准备审计并立即返回 `started`。
- 完成通过 `windowsSandbox/setupCompleted` 通知。
- 不完整审计或发现世界可写路径时先发送 `windows/worldWritableWarning`。
- Windows 上 restricted policy 的 `SandboxAvailability` 为 `restricted`，不再降级为不可用。

## 验证

Windows 测试覆盖：

- Workspace 写入允许，外部路径和 read-only 写入拒绝。
- `.git` 与 junction 逃逸拒绝。
- 原用户目录 sibling 读取拒绝。
- Job 关闭后后代进程不能存活。
- `agent-exec` 的 Pipe 与 ConPTY 都通过源码构建 wrapper 执行。
- readiness、setup、warning 和 completed 通知通过固定 V2 Schema。

GitHub Windows runner 执行 `agent-sandbox`、`agent-exec`、桌面 Rust 测试和 NSIS 构建；macOS 本地和 CI 继续验证 Seatbelt 路径。R17 在此隔离基础上增加域名网络规则、代理归因和连接审批。
