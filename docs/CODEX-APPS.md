# Codex Apps 与连接器

## 协议

R33 按固定 `rust-v0.145.0` App Server V2 实现：

- `app/list`：固定排序、最多 100 项的游标分页；`forceRefetch` 发布 `app/list/updated`。
- `app/read`：最多读取 100 个 App ID，按首次出现顺序去重，返回缺失 ID 和可选工具摘要。
- `app/installed`：返回有效启用状态、运行时名称及是否有非 synthetic、模型可见的可调用工具。
- `app/list/updated`：插件安装、卸载或显式刷新目录后发布。

所有请求和响应都会先通过固定 V2 Rust 类型校验。插件 App 从已激活插件的 Apps 清单读取，内置 Device Fabric 和插件目录在 `crates/agent-apps` 合并；重复 ID、重复工具名和非对象输入 Schema 会使目录加载失败。

## Dynamic Tool

Tietiezhi Device Fabric 是内置 App，不再作为 Codex Runtime 的特殊旁路：

- `tietiezhi_devices.list` 返回本机、Core 和远端设备以及各自实际公开的能力。
- `tietiezhi_devices.invoke` 只接受目录中存在的精确设备 ID 和该设备已公开的能力。
- `system.ping`、`system.status`、`core.health`、`core.devices` 是显式只读能力。
- 其他能力按设备、能力和完整参数生成精确会话授权键；`approvalPolicy=never` 时拒绝不可沙箱化的副作用。
- 调用依次经过 PreToolUse、Permission Hook、Guardian、App Server V2 Approval、PostToolUse 和取消处理。
- 时间线使用正式 `dynamicToolCall` Item；参数、结果、成功状态和耗时写入 canonical rollout。

插件 App 的元数据与工具 annotations 保持来源信息。插件提供的实际 MCP 工具继续由 R19 MCP Runtime 执行，因此同样接受 annotations、OAuth、审批、Hook、富媒体结果和 Item 生命周期。

## 桌面

当前 Thread 的工作区栏提供 Apps 面板，展示目录来源、启用/可调用状态和公开 Dynamic Tool 摘要。刷新同时调用 `app/list(forceRefetch)` 与 `app/installed(forceRefresh)`，不维护第二套前端目录。

## 验证

- `cargo test --manifest-path crates/agent-apps/Cargo.toml`
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml`
- `pnpm test:codex-apps-ui`
- `pnpm test:codex-protocol-ts`
- `pnpm typecheck`
- `pnpm build`
