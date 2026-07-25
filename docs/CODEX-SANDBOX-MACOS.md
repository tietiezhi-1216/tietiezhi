# Codex macOS Seatbelt

## 范围

R15 在仓库源码中实现 macOS Seatbelt，不调用或打包 Codex 二进制。`crates/agent-sandbox` 是平台隔离入口，`agent-exec`、Unified Exec 和 App Server `command/exec` 共用同一 `SandboxPolicy`。

支持固定 App Server V2 的四类策略：

- `dangerFullAccess`：不套用 Codex 外层沙箱。
- `externalSandbox`：隔离由外部环境提供，不重复包装。
- `readOnly`：允许读取，禁止文件写入；网络由策略单独控制。
- `workspaceWrite`：只允许写入工作区、显式可写根和未排除的临时目录。

## Seatbelt 策略

- 固定调用系统 `/usr/bin/sandbox-exec`，不通过 `PATH` 解析。
- 基础 Profile 与网络 Profile 来自固定上游 `rust-v0.145.0`。
- 默认拒绝所有未声明操作，再开放进程执行、系统读取和策略允许的写入。
- `.git`、`.agents`、`.codex` 在每个可写根下仍禁止写入。
- `excludeTmpdirEnvVar` 和 `excludeSlashTmp` 分别控制 `$TMPDIR` 与 `/tmp`、`/private/tmp`。
- 禁止网络时不加载 outbound/inbound 规则；允许网络时加载固定网络 Profile。
- Pipe 和 PTY 在创建子进程前完成相同的命令包装，后台进程与子进程继承 Seatbelt。

## Patch 安全

`apply_patch` 在进程内完成原子事务，因此执行前按 Codex `assess_patch_safety` 语义审查全部源路径和移动目标：

- `workspaceWrite` 内的普通文件可以自动执行。
- `readOnly`、工作区外路径和受保护元数据需要沙箱升级审批。
- `never` 或关闭 sandbox approval 的 granular 策略直接拒绝越界 Patch。
- `untrusted` 始终询问。
- 已存在路径和最深已存在父目录都会 canonicalize，新文件不能借助 symlink 父目录逃逸。
- R12 的 Patch 引擎仍执行工作区约束、全量预演、同文件系统 staging 和多文件回滚。

## 补充权限

`with_additional_permissions` 只扩展明确请求的权限：

- 只申请网络时保持 `readOnly`，不会隐式获得 cwd 写权限。
- 相对可写根相对实际命令 cwd 解析。
- `require_escalated` 经审批后切换为 `dangerFullAccess`。
- 已经处于 `dangerFullAccess` 或 `externalSandbox` 时不重复扩大权限。

## 验证

真实 macOS 测试覆盖：

- 工作区写入成功，工作区外写入失败。
- `readOnly` 写入失败。
- `.git` 等元数据写入失败。
- symlink 父目录逃逸失败。
- 排除临时目录后 `/tmp` 写入失败。
- 网络关闭时 loopback 连接失败，开启时成功。
- `agent-exec` Pipe 与 PTY 都实际继承 Seatbelt。
- 只读且 `never` 时 Patch 被拒绝且不写盘。

R16 已在同一 `SandboxPolicy` API 下实现 Windows Restricted Token、ACL、Job Object 与 ConPTY 隔离，详见 `docs/CODEX-SANDBOX-WINDOWS.md`；R17 再增加域名级网络代理和连接审批。
