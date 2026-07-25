# Codex Network Policy

## 范围

R17 在源码级 Runtime 中建立命令网络的受信代理边界，模型 API、Hosted Web Search 和命令网络使用独立客户端与授权面。

- `crates/agent-network` 提供执行归因的 HTTP CONNECT、普通 HTTP 和 SOCKS5 TCP 代理。
- 每次命令生成独立随机 attribution token，写入代理凭据与 `CODEX_NETWORK_PROXY_ATTRIBUTION`。
- `agent-tools`、Unified Exec 和 App Server `command/exec` 在 restricted network 下自动注入代理环境。
- `thread/shellCommand` 是用户显式的非沙箱终端，不继承代理环境。
- macOS Seatbelt 只开放当前代理的 loopback 端口，显式忽略代理环境的直连会被 OS 沙箱拒绝。

## 策略

- 域名支持 exact、`*.example.com` 和 `**.example.com`。
- 同一 host 同时匹配时 `deny` 高于 `allow`，`allow` 高于 `none/ask`。
- host 统一小写、移除 FQDN 尾点和防御性端口。
- `limited` 只允许普通 HTTP 的 `GET`、`HEAD`、`OPTIONS`；无法检查方法的 HTTPS CONNECT 与 SOCKS5 在没有 MITM 时失败关闭。
- `full` 允许策略准入后的全部方法。
- DNS 解析后再次拒绝 loopback、private、link-local、multicast、unspecified、CGNAT、benchmark 和 reserved 地址，避免 DNS rebinding。
- `allowLocalBinding` 必须显式开启，不能由域名 allowlist 间接放开。

## 审批与规则

- 只有 decider 返回 `ask` 时发送 `item/commandExecution/requestApproval`。
- 请求带精确的 host、protocol、port、Thread、Turn、Item 和 command。
- `accept` 只允许本次连接。
- `acceptForSession` 缓存精确 Network Approval Key。
- `applyNetworkPolicyAmendment` 原子写入 `approval-rules.json`，并立即刷新共享代理。
- 显式 deny 不提供提权旁路；`decline` 关闭当前连接，`cancel` 保持 Turn 取消语义。
- 每次决策记录 thread、turn、item、protocol、host、port、source、reason 和最终 decision。

## 拒绝语义

- HTTP/CONNECT 返回 `403 Forbidden` 和 `X-Proxy-Error`，不以空连接伪装普通网络故障。
- SOCKS5 使用标准失败 reply。
- 未知、缺失或过期 attribution token 一律拒绝。
- PreparedNetwork 生命周期结束即移除 attribution context，后台连接不能跨执行复用授权。

## 平台边界

- macOS 已验证代理端口可访问且另一个 loopback 端口不可直连。
- Windows 使用 `TietiezhiSandboxOffline` 与 `TietiezhiSandboxOnline` 两个源码安装的本地身份。restricted/managed network 命令通过 Offline 身份自重入，再叠加 Restricted Token、capability SID、ACL 与 Job Object。
- Offline 身份的非 loopback 出站全部由 Windows Firewall 拒绝；loopback TCP 只保留当前 HTTP/SOCKS 代理端口，其余 TCP 与 UDP 全部拒绝。代理端口变化会重新运行提升权限的幂等设置。
- WFP 按 Offline 用户额外安装持久过滤器，覆盖 ICMP、DNS 53/853 和 SMB 139/445 的 IPv4/IPv6 connect/resource-assignment 绕过面。
- 设置 helper 由当前安装包源码自重入并通过 UAC 运行，不下载或启动上游 Codex 二进制。Offline/Online 密码每次设置随机轮换并使用机器域 DPAPI 加密。
- 企业组策略导致本地 Firewall 规则无效、UAC 被取消、身份或 WFP 设置不完整时一律失败关闭，不会只注入代理环境后继续执行。

## 验证

- 域名优先级、wildcard、host 规范化和私网范围。
- attribution token、未知 token、普通 HTTP 转发和结构化拒绝。
- 会话 Amendment 与持久 Amendment 隔离。
- Unified Exec 真实通过代理访问本地测试源站。
- Seatbelt 真实阻止绕过代理直连另一个 loopback 端口。
- Windows runner 验证 Offline 身份能访问指定代理端口，但不能绕过到同机另一个 TCP 端口；setup marker 同时要求 Firewall 成功和非零 WFP filter 数。
- `agent-network` Clippy、Rust、桌面 Rust、协议与生产构建纳入 CI。
