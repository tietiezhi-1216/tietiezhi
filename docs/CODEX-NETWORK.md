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
- Windows 的 unelevated Restricted Token 无法按 capability SID 做可靠网络过滤。当前遇到 managed proxy 会失败关闭，不会仅靠环境变量假装隔离。
- 完整 Windows 网络启用仍需源码构建的 elevated sandbox identity、Firewall/WFP 规则与代理端口刷新；该项保留为 R17 阶段风险，未关闭前不得通过 R39 安全发布门禁。

## 验证

- 域名优先级、wildcard、host 规范化和私网范围。
- attribution token、未知 token、普通 HTTP 转发和结构化拒绝。
- 会话 Amendment 与持久 Amendment 隔离。
- Unified Exec 真实通过代理访问本地测试源站。
- Seatbelt 真实阻止绕过代理直连另一个 loopback 端口。
- `agent-network` Clippy、Rust、桌面 Rust、协议与生产构建纳入 CI。
