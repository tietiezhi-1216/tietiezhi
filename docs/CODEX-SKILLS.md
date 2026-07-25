# Codex Skills

R22 的技能目录按 system/admin、用户 `$CODEX_HOME/skills`、`$HOME/.agents/skills`、项目根到 cwd 的 `.codex/skills`/`.agents/skills`、插件和运行时 extra roots 合并。

- 扫描不跟随符号链接，限制目录深度和单个 `SKILL.md` 大小。
- 列表阶段只解析 YAML frontmatter 与可选 `SKILL.json` 的 interface/dependencies。
- 正文仅在模型调用 `skill({name})` 时读取。
- 启停规则支持 canonical path 和 name，path 优先。
- `skills/extraRoots/set`、配置写入和检测到的文件变化发送 `skills/changed`。
- 可用技能名称进入 `skill` 工具 Schema，技能元数据同时进入 World State；禁用或不存在的技能不会暴露给模型。

已实现 `skills/list`、`skills/config/write`、`skills/extraRoots/set` 和 `skills/changed`，并用固定 V2 生成类型验证响应。
