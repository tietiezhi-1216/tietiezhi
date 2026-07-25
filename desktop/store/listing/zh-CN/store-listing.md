# Tietiezhi

## 简短说明

按下快捷键说话，自动识别、润色并输入到当前应用。

## 产品说明

Tietiezhi（铁铁汁）是一款本地优先、开源的桌面 AI 助手。添加兼容 OpenAI API 的模型服务地址与 API Key 后，即可使用全局语音听写、AI 文本润色、对话、任务管理和智能体工作区。

主要功能：

- 连接兼容 OpenAI API 的模型服务，可自由选择模型与供应商
- 使用全局快捷键开始语音听写，将录音识别为文字
- 使用可编辑的提示词和独立模型润色识别结果
- 将最终文字自动输入当前应用；无法自动输入时保留复制结果
- 以任务和项目组织对话与本地工作区
- 支持文件读写、搜索、命令执行等智能体工具，并提供明确的权限控制
- 支持 Skills 与 MCP 服务扩展
- API Key 通过 Windows 安全凭据存储保存，不以明文写入配置文件
- 开源、无内置模型服务账号，数据流向由你配置的模型服务决定

Tietiezhi 不内置付费模型或 API Key。使用 AI 对话和语音听写前，需要登录 Tietiezhi Gateway，或准备兼容 OpenAI API 的服务地址和密钥。使用语音听写时，录音会发送到用户选择的语音识别服务，识别文字会在启用润色时发送到用户选择的润色模型；应用不会保留录音文件。

## 商店元数据

- 类别：生产力
- 定价：免费
- 许可证：Apache License 2.0
- 隐私政策：https://github.com/tietiezhi-1216/tietiezhi/blob/main/docs/PRIVACY.md
- 支持：https://github.com/tietiezhi-1216/tietiezhi/issues
- 网站：https://tietiezhi-1216.github.io/tietiezhi/
