# Codex Runtime GA 发布门禁

## 发布条件

桌面版本只有同时满足以下条件才能创建 `v<version>` Tag：

- `shared/codex/v2/upstream-baseline.json` 中 R0-R39 全部完成。
- 89 Client Request、1 Client Notification、10 Server Request、70 Server Notification 全部为 `implemented` 或 `service_mapped`。
- `package.json`、`tauri.conf.json`、`Cargo.toml` 和 `Cargo.lock` 的应用版本完全一致。
- Workspace 不存在 `chat_stream` 或 `run_agent_loop` 回退入口。
- 固定 Codex Schema、TypeScript、模型目录、迁移、审批、时间线和 Runtime 切换门禁通过。
- Rust 状态/Core/桌面测试、故障注入、TypeScript 和生产构建通过。
- 全部 JavaScript 依赖通过 `pnpm audit --audit-level low`，Rust Lockfile 通过 `cargo audit`。
- 仓库没有高置信私钥、GitHub、AWS 或 Slack Token，也没有被跟踪的 `.env`、`.pem`、`.key`、`.p12` 或 `.pfx`。
- Tauri CSP、Updater HTTPS 端点、Updater 公钥与最小 Capability 集合有效。
- GitHub Secrets 包含 Apple 签名/公证配置和 Tauri Updater 签名私钥。

`pnpm test:codex-release` 将上述静态不变量纳入普通 CI 和 Tag 发布流水线。

## 升级与回滚演练

升级路径：

1. 启动时扫描旧 `task.json`，使用原 UUID、项目目录和 Workspace 导入 canonical Thread。
2. canonical `session_meta` 追加到原 rollout，不重写已有日志。
3. SQLite 索引可以删除并从 rollout 重建。
4. 新 Turn 只写 canonical Thread/Turn/Item 记录。

回滚路径：

1. 退出当前版本，确认没有活动 Turn、终端或 Automation。
2. 安装上一版桌面包。
3. 上一版继续读取未改写的 `task.json` 和 `legacy_checkpoint`。
4. Local/Worktree 文件仍在原位置，不需要复制或恢复。
5. 如果只需修复索引，可删除 `agent-runtime/state.sqlite3`，当前版会从 rollout 重建。
6. 不手工编辑或截断 `rollout.jsonl`；Doctor 和 Feedback 报告用于定位损坏。

自动测试 `legacy_import_preserves_the_rollback_snapshot_byte_for_byte` 验证导入前后 `task.json` 字节完全一致，旧 checkpoint 仍可读取，同时 canonical metadata 可以恢复。

## 安全基线

- Workspace Agent 只使用 Responses API 与 App Server V2。
- 模型工具副作用统一经过 Approval、Sandbox、Network 和 ExecPolicy。
- macOS 使用 Hardened Runtime、签名、公证和 DMG staple。
- Windows 使用 Restricted Token、ACL、Job、ConPTY、Firewall/WFP 网络出口和 Updater 签名。
- CSP 禁止远程脚本、frame、object、form 与 base 重定向；仅允许本地资源、Tauri IPC、受限资产协议和 DiceBear 头像图片。
- 发布工作流在构建前验证所有签名 Secret 非空，不允许无签名 Updater 或未公证 macOS 包降级发布。
- Release 必须包含 macOS DMG、通用架构 updater tarball/signature、Windows NSIS/signature 和 `updater-latest.json`。

## 发布流程

1. 在干净提交上执行完整 R39 门禁。
2. 运行 `pnpm version:timestamp`，提交四处同步版本。
3. 创建并推送 `v<version>` Tag。
4. `release.yml` 先执行 GA、安全与回滚门禁。
5. macOS 构建 universal app/DMG，完成签名、公证和 staple。
6. Windows 构建 x64 NSIS，并生成 Updater signature。
7. 发布作业生成多平台 `updater-latest.json` 并创建 GitHub Release。
8. 验证 Release 资产、Updater JSON、DMG staple、Windows 安装器和工作流结论。

## 本地验证

```bash
cd desktop
pnpm test:codex-release
pnpm audit --audit-level low
pnpm typecheck
pnpm build

cd ..
cargo audit --file desktop/src-tauri/Cargo.lock
cargo test --manifest-path crates/agent-state/Cargo.toml
cargo test --manifest-path crates/agent-core/Cargo.toml
cargo test --manifest-path crates/agent-stability/Cargo.toml -- --test-threads=1
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```
