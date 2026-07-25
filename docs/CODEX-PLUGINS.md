# Codex Plugins 与 Marketplace

## 范围

R24 以固定 `rust-v0.145.0` 为行为基线，在 `crates/agent-plugins` 内实现 App Server V2 的 14 个 Marketplace、Plugin 和 Share 请求。运行时不调用或嵌入 Codex 二进制。

## 包与 Marketplace

- 发现 `.agents/plugins/marketplace.json`、`api_marketplace.json`、Claude 和 Cursor 兼容清单。
- `marketplace/add` 支持本地绝对路径、`file://` 和源码级 Git clone；upgrade 仅执行 fast-forward，并在校验失败时恢复备份。
- 安装先复制到 staging，拒绝 symlink，重新校验 Manifest 后原子替换；卸载只删除受管安装根。
- `.codex-plugin/plugin.json` 支持 Skills、Hooks、MCP、Apps 与界面资产。
- Manifest 路径必须以 `./` 开头，canonical path 必须留在插件根内。

## 激活

- Skills 作为额外根进入 `SkillsRuntime`，仍采用元数据预加载、正文延迟读取。
- Hooks 标记为 `Plugin` 来源并进入统一信任和生命周期执行器。
- MCP 配置转换为独立服务器命名空间，继续使用 R14 审批、R17 网络策略和 R19 OAuth/资源/富媒体能力；`mcpToolCall.pluginId` 记录插件来源。
- `plugins."<plugin>@<marketplace>".enabled` 配置写入会立即刷新上述激活集合，未安装插件的选择也会保留到后续安装。
- Apps 清单已验证并显示在 Plugin Detail；真正的 Dynamic Tool/App 执行在 R33 统一接入，避免形成审批旁路。

## Share 映射

OpenAI 托管的 Plugin Share 服务不能在本地复制。相同 V2 生命周期映射到应用数据目录中的可审计共享存储，并通过个人 Marketplace checkout；后续可在不改变桌面协议的前提下替换为 Tietiezhi Gateway 服务。

## 恢复与验证

- Marketplace、安装、启停和 Share 状态原子写入 `state.json`。
- 安装、Marketplace upgrade 和 Share 更新均保留 rollback 边界。
- Rust 测试覆盖全部 14 个响应的官方类型反序列化、安装/卸载、启停、共享、路径逃逸和 MCP 转换。
- CI 在 macOS 与 Windows 分别执行插件 crate、桌面全量测试、协议检查、类型检查和生产构建。
