# Third-Party Notices

## OpenAI Codex

Tietiezhi 的 Codex Runtime 对齐工作参考并可能移植 OpenAI Codex 的 Apache-2.0 源码。

- Project: OpenAI Codex
- Source: https://github.com/openai/codex
- Pinned version: `rust-v0.145.0`
- Pinned commit: `25af12f7e61572b0bc18ddb1008be543b91519b0`
- License: Apache License 2.0
- Copyright: Copyright 2025 OpenAI

移植具体源文件时，必须在本文件和对应源文件中补充精确的上游路径及修改说明。

R2 固定了以下上游生成物，未修改协议内容：

- `shared/codex/v2/schema/` 来源于 `codex-rs/app-server-protocol/schema/json/`。
- `shared/codex/v2/typescript/` 来源于 `codex-rs/app-server-protocol/schema/typescript/`。
- `crates/agent-protocol/` 使用上述 JSON Schema 编译生成本项目 Rust 类型；服务端请求枚举因通用生成器无法表达上游交叉类型，按 `codex-rs/app-server-protocol/src/protocol/common.rs` 的方法映射在本仓库源码实现；JSON-RPC Envelope 移植自 `codex-rs/app-server-protocol/src/rpc.rs`，仅将 Trace Context 改为本地同形类型。
