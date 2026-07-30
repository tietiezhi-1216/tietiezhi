# Tietiezhi 隐私说明

Tietiezhi 是本地优先的开源 Electron 桌面应用。

- 对话、运行记录、Provider 元数据、图片任务和资产索引保存在本机 SQLite。
- API Key 与中转站登录 Session 通过 Electron `safeStorage` 加密，SQLite 只保存凭据引用。
- 登录 Tietiezhi Gateway 时，应用使用系统浏览器和本机回环地址完成 PKCE 授权；授权码只用于交换本机加密保存的 Session 与 API Key。
- 应用启动及账号菜单刷新时会请求官方中转站的 discovery 与 Session 校验接口；退出登录时会尝试撤销远端 Session，并始终清除本地凭据。
- 对话内容只发送给用户选择的模型供应商。
- 图片 Prompt 只发送给用户选择的图片模型供应商。
- 生成图片原始文件保存在本机应用数据目录。
- Workspace Agent 可以读取用户选择的项目目录；未选择项目时只访问应用创建的隔离临时目录。
- 文件写入、文本替换和 Shell 命令必须经过用户审批；工具结果会作为 Agent 上下文发送给所选模型供应商。
- 应用不包含广告、追踪、分析或默认遥测。
- 当前版本不包含 MCP、外部 CLI Agent 或设备控制能力。

用户应自行审查所选模型供应商的隐私政策和数据处理规则。
