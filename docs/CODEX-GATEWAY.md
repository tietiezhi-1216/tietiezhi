# Codex Gateway 与账号映射

## 实现边界

R8 将固定基线 `rust-v0.145.0` 的 App Server V2 账号协议映射到 Tietiezhi Gateway 和自定义 OpenAI-compatible Provider。实现位于：

- `crates/agent-account`：协议校验、账号缓存、登录状态、全局通知和 Server Request 关联。
- `desktop/src-tauri/src/commands/codex.rs`：Gateway、Keyring、Provider 和 Responses Runtime 适配。
- `desktop/src-tauri/src/commands/gateway_auth.rs`：PKCE 浏览器登录、会话、撤销和额度服务。
- `crates/agent-model`：Responses 能力探测和在线模型目录投影。

实现不运行或嵌入 Codex 二进制。OpenAI 专有账号后端没有本地复制；同名协议根据当前 Provider 映射到 Gateway、Keyring 或外部令牌宿主。

## Responses Provider

- 官方 `Tietiezhi Gateway` 固定使用 `responses` wire API，Agent Runtime 不回退到 Chat Completions。
- 自定义 Provider 可选 `responses`、`chatCompletions` 或 `auto`。
- `auto` 向 `/v1/responses` 发送空 JSON POST。请求会在模型路由前失败，不产生模型生成；401、403、400、405 和 429 证明路由存在，404、501 或包装的 `Not Found` 表示不支持。
- 探测结果只在当前进程按 Provider ID 与 base URL 缓存，不写入用户配置。
- 普通聊天仍可使用 `/v1/chat/completions`；配置为 `chatCompletions` 的 Provider 不允许启动 Agent Turn。

Gateway 仓库已具备 `/v1/responses`、`/v1/responses/compact`、SSE 转发、usage 计费和 vendor adapter。R8 在 Gateway 提交 `be473f1` 中增加 Discovery 能力声明和路由鉴权回归测试。生产公开入口用无凭据空 POST 验证返回标准 401，证明请求进入 API Key 中间件而不是包装为 200 的 NoRoute。

## 账号生命周期

| App Server V2 | Tietiezhi 映射 |
| --- | --- |
| `account/login/start` `chatgpt` | 官方 Gateway 的系统浏览器 PKCE S256 登录；立即返回 `loginId` 和 `authUrl` |
| `account/login/start` `apiKey` | 自定义 Provider Keyring；明文不进入前端状态或 rollout |
| `account/login/start` `chatgptAuthTokens` | 自定义 Provider 的进程内令牌；退出或重启后清除 |
| `account/login/cancel` | 只取消匹配 `loginId` 的回环回调监听 |
| `account/logout` | Gateway 会话和专用 API Key 同步撤销，或删除自定义 Provider 凭据 |
| `account/read` | Gateway 原生会话、Keyring 或外部令牌投影 |
| `account/chatgptAuthTokens/refresh` | 401 且尚未产生模型 Item 时向所有连接发送反向 Server Request，按 Request ID 等待最多 60 秒后只重试一次 |

所有账号请求在 OAuth、Keyring、网络和内存令牌副作用前通过固定 V2 Schema 校验。业务失败返回 JSON-RPC Error；只有 IPC 发射或 Runtime 状态损坏才使 Tauri command 失败。

登录完成按 Codex 顺序发送 `account/login/completed`，随后发送全连接 `account/updated`。取消旧登录后，迟到回调不能覆盖新账号。

## 额度与服务差异

- `account/rateLimits/read` 将 Gateway 钱包微分和套餐窗口映射为 Codex rate-limit snapshot。
- 钱包金额以 `int64` 微分读取并格式化为六位小数字符串，不经过浮点转换。
- `account/rateLimits/updated` 使用稀疏通知，只发送当前 `rateLimits`。
- Gateway 没有 reset-credit 服务时，已登录 Gateway 账号返回 `noCredit`；空幂等键和空 credit ID 与 Codex 一样返回 Invalid Request。
- Gateway 没有“加额提醒邮件”服务时返回明确 Invalid Request，不伪造 `sent`。
- Gateway 当前消费记录是金额账本而不是 Token 日聚合，因此 `account/usage/read` 返回协议有效的空 summary，不伪造 Token。
- Gateway 当前没有 Workspace Message 后端，因此 `account/workspaceMessages/read` 返回 `featureEnabled: false`。

## 在线模型目录

Provider 的 `/v1/models` 元数据是运行时权威来源。`model/list` 将已缓存的模型清单映射为 App Server V2：

- 过滤非文本模型和空 ID。
- 服务端 reasoning levels、默认 effort 与 text/image 输入模态覆盖固定模型的对应能力。
- 固定模型保留上游公开名称、说明和其它稳定字段。
- 未知模型生成完整 V2 Model，并通过 Rust 生成类型反序列化校验。
- `cursor`、`limit`、JSON-RPC 请求和响应均在返回前校验。

## 验证

```bash
cargo test --manifest-path crates/agent-account/Cargo.toml
cargo clippy --manifest-path crates/agent-account/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path crates/agent-model/Cargo.toml
cargo test --manifest-path desktop/src-tauri/Cargo.toml
cd desktop && pnpm typecheck && pnpm build
```

Gateway 独立仓库执行 `go test ./...`，覆盖固定 Responses 路由、API Key 中间件和 Discovery 声明。
