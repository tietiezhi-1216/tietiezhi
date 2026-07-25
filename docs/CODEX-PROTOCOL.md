# Codex App Server V2 协议

## 固定来源

- Codex 版本：`0.145.0`
- Git Tag：`rust-v0.145.0`
- Git Commit：`25af12f7e61572b0bc18ddb1008be543b91519b0`
- 上游模块：`codex-rs/app-server-protocol`
- 许可证：Apache-2.0

`shared/codex/v2/schema/` 和 `shared/codex/v2/typescript/` 是上述固定提交生成的官方快照。前者是 Rust 类型的单一事实源，后者用于前端协议类型和跨语言 fixture 校验。仓库不下载、运行或打包 Codex 二进制。

## Rust 类型

`crates/agent-protocol` 使用 `typify` 从固定 JSON Schema 在编译期生成 V2 类型，覆盖：

- 89 个 Client Request
- 1 个 Client Notification
- 10 个 Server Request
- 70 个 Server Notification
- 532 个 V2 Schema Definition
- JSON-RPC Request、Notification、Response 和 Error Envelope

Codex 的 `ServerRequest` Schema 包含通用生成器不能直接展开的交叉类型，因此本仓库按上游 `protocol/common.rs` 的十个方法映射声明枚举，各参数仍由对应官方 Schema 生成。MCP 表单 Schema 只做确定性的根定义抽取，生成物位于 `shared/codex/v2/compat-schema/`，没有修改字段或枚举。

## 一致性门禁

在 `desktop/` 执行：

```bash
pnpm check:codex-schema
pnpm test:codex-protocol-ts
cargo test --manifest-path ../crates/agent-protocol/Cargo.toml
```

`check:codex-schema` 会校验四类方法与 machine ledger 完全一致、所有 TypeScript 文件保留官方生成标记，并校验 JSON/TypeScript 目录的聚合 SHA-256。只有升级固定 Codex Tag 时才允许执行：

```bash
pnpm check:codex-schema -- --write
```

Rust 测试同时检查由 Rust 类型反向生成的 Schema 方法数量，并对 Client Request、Client Notification、Server Request、Server Notification、JSON-RPC Response 和 MCP Elicitation fixture 做反序列化再序列化的双向回归。

## 当前边界

R2 只建立协议类型边界，不代表对应方法已经具备运行时行为。方法实现状态继续保持 `pending`，由 R3-R39 在事件、生命周期、模型、工具、沙箱和产品能力阶段逐项转为 `implemented` 或 `service_mapped`。
