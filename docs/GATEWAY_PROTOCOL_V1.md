# Tietiezhi Gateway Protocol v1

本文定义桌面端与中转站之间的第一版稳定边界。第一阶段只完成鉴权发现、身份确认和模型目录，不接入任何上游模型厂商。

## 设计结论

- 登录与 API Key 是两种并行鉴权模式，不再“登录后生成 API Key”。
- OAuth 登录使用系统浏览器、Authorization Code、PKCE S256 和 loopback 回调。
- OAuth Token Endpoint 只返回标准令牌；鉴权成功后，客户端再请求 `GET /v1/bootstrap` 获取统一 JSON。
- 两种模式都使用 `Authorization: Bearer <credential>` 访问同一套资源接口。
- `X-Tietiezhi-Auth-Mode` 表示客户端选择的模式，可省略；服务端必须根据真实凭据确认类型，不能信任该 Header。
- 模型目录返回网关稳定模型 ID 和能力，不向桌面端暴露上游厂商路由或协议。

## 端点

| 端点 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /.well-known/tietiezhi-gateway` | 否 | Tietiezhi 完整能力发现 |
| `GET /.well-known/oauth-authorization-server` | 否 | RFC 8414 OAuth 元数据 |
| `GET /oauth/authorize` | 浏览器会话 | OAuth 授权 |
| `POST /oauth/token` | PKCE / refresh token | 获取或刷新登录令牌 |
| `POST /oauth/revoke` | 凭据 | 撤销登录令牌 |
| `GET /v1/bootstrap` | Bearer | 返回身份、端点和首屏模型目录 |
| `GET /v1/models` | Bearer | 独立刷新模型目录，支持 `ETag` |

## 登录模式

1. 桌面端读取发现文档并校验所有端点与 `issuer` 同源。
2. 生成 `state`、`code_verifier` 和 S256 `code_challenge`，使用系统浏览器打开授权页。
3. 中转站重定向至桌面端临时 loopback 地址；桌面端校验 `state`。
4. 桌面端以授权码和 `code_verifier` 换取标准 OAuth JSON：

```json
{
  "access_token": "opaque-short-lived-token",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "rotating-refresh-token",
  "scope": "models:read responses:create"
}
```

5. 桌面端用 access token 请求 `GET /v1/bootstrap`，并把令牌交给 Electron `safeStorage` 保存。
6. access token 到期前使用 rotating refresh token 刷新；退出登录时调用撤销端点。

登录模式永远不返回或创建开发者 API Key。

## API Key 模式

1. 用户直接输入已在中转站控制台创建的 API Key。
2. 桌面端用该 Key 请求 `GET /v1/bootstrap` 验证有效性和权限。
3. 成功后用 `safeStorage` 保存原始 Key；SQLite 只保存引用和非敏感显示信息。
4. API Key 不参与 refresh token 流程，撤销、轮换和权限由中转站控制台管理。

## 鉴权后的统一 JSON

`GET /v1/bootstrap` 是登录后的首个资源请求。登录和 API Key 返回同一种结构，仅 `auth.mode`、主体和可选账号信息不同：

```json
{
  "schema_version": "tietiezhi.gateway.v1",
  "object": "gateway.bootstrap",
  "issued_at": "2026-08-03T00:00:00Z",
  "auth": {
    "mode": "login",
    "subject": "user_01",
    "scopes": ["models:read", "responses:create"],
    "expires_at": "2026-08-03T01:00:00Z"
  },
  "account": {
    "id": "user_01",
    "email": "user@example.com",
    "display_name": "示例用户"
  },
  "endpoints": {
    "models": "https://gateway.example.com/v1/models",
    "responses": "https://gateway.example.com/v1/responses"
  },
  "models": {
    "schema_version": "tietiezhi.gateway.v1",
    "object": "list",
    "revision": "catalog-2026-08-03-1",
    "data": []
  }
}
```

API Key 可能属于服务账号，因此 `account` 可以缺省。`subject` 始终存在，用于稳定标识当前授权主体。

## 模型目录

`GET /v1/models` 返回与 Bootstrap 内相同的 `ModelList`。服务端返回 `ETag: "<revision>"`；客户端缓存最近一次有效目录，并使用 `If-None-Match` 刷新。

模型字段分为四类：

- 身份：`id`、`display_name`、`owned_by`、`created`、`status`。
- 能力：输入/输出模态、流式、工具调用、结构化输出、推理。
- 限制：上下文窗口和最大输出 token；无法可靠承诺时返回 `null`。
- 生命周期：弃用时间和替代模型。

`id` 是中转站的稳定逻辑 ID。未来接入厂商时，由服务端内部路由把该 ID 映射到供应商模型；客户端不得依赖厂商名、Base URL 或原始模型 ID。

## 错误协议

所有非 2xx 响应统一为：

```json
{
  "error": {
    "code": "unauthorized",
    "message": "凭据无效或已过期",
    "request_id": "req_01"
  }
}
```

`code` 供程序判断，`message` 供用户阅读，`request_id` 用于服务端排查。首批稳定错误码为 `unauthorized`、`invalid_auth_mode`、`insufficient_scope`、`catalog_unavailable`、`gateway_misconfigured` 和 `rate_limited`。

## 安全与服务端实现

- 原生桌面应用不保存 client secret；登录强制 PKCE S256。
- access token 建议 15–60 分钟有效；refresh token 每次使用时轮换，并检测重复使用。
- API Key 仅在创建时展示一次，服务端只保存强哈希；前缀只用于定位，不参与鉴权。
- access token、refresh token 和 API Key 都必须支持作用域、撤销、审计和限流。
- 发现文档中的 API、OAuth 端点必须与 `issuer` 同源，避免凭据被配置劫持。

当前仓库中的 `server/internal/gatewayprotocol/v1` 是可挂载的协议层和鉴权/目录接口，不包含生产账号库。实际中转站只需实现 `Authenticator` 与 `CatalogProvider`，再将 Handler 挂到公网网关；厂商接入应在这层稳定后单独进行。

## 仓库产物

- TypeScript 契约：`app/src/shared/gateway-protocol.ts`
- 无 SDK 桌面客户端：`app/src/main/gateway/gateway-client.ts`
- Go 协议与 HTTP Handler：`server/internal/gatewayprotocol/v1/`
- 示例 JSON：`docs/protocol/examples/`
- ModelList JSON Schema：`docs/protocol/schemas/gateway-model-list.v1.schema.json`
