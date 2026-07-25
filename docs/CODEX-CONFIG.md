# Codex 配置与 Requirements

## 配置层

R21 使用以下从低到高的优先级合并 TOML：

1. 系统 `config.toml`
2. 用户 `config.toml`
3. 用户选中的 Profile
4. 从项目根到当前目录的 `.codex/config.toml`
5. 会话参数继续由 Thread/Turn 覆盖

对象递归合并，标量和数组由高优先级替换。`config/read` 可以返回每层内容、稳定内容版本和每个叶子字段的最终来源。

## 写入

`config/value/write` 和 `config/batchWrite` 支持 `replace`、`upsert`，并接受 `expectedVersion` 做乐观并发控制。写入先生成同目录临时文件、同步数据，再原子重命名，批量编辑不会留下部分结果。

配置版本是文件内容的 SHA-256。显式 `filePath` 必须为绝对路径，key path 拒绝空段和原型污染字段。

## Requirements

系统 `requirements.toml` 在全部普通配置层之后生效。当前强制约束：

- `allowedApprovalPolicies`
- `allowedSandboxModes`
- `allowedWebSearchModes`
- `featureRequirements`

普通配置只能在允许集合内选择，不能通过项目或用户层放宽管理要求。发生收紧时返回有效值，并发送 `configWarning`，其中包含要求文件和差异说明。

## App Server V2

已实现并做生成类型往返验证：

- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`
- `config/mcpServer/reload`
- `experimentalFeature/list`
- `experimentalFeature/enablement/set`
- `configWarning`

MCP reload 会清理当前连接，下一次工具目录或调用按最新配置重新建立。实验功能启停持久化到用户配置的 `features` 表。
