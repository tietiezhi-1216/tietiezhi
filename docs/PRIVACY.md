# Tietiezhi 隐私政策

最后更新：2026-07-19

Tietiezhi 是一个本地优先的开源桌面应用。本政策说明桌面应用何时保存或传输数据。

## 项目本身不收集的数据

Tietiezhi 项目不运营默认的模型服务，不内置真实 API Key，也不包含广告、用户追踪、遥测或分析服务。项目维护者不会通过应用自动收集聊天内容、任务内容、API Key、录音或本地文件。

## 本地存储

应用会在用户设备上保存完成其功能所需的数据，包括：

- 用户添加的模型服务名称、baseURL、模型选择和非敏感设置；
- 任务、聊天记录、智能体配置和用户创建的工作区文件；
- 用户主动添加的技能与 MCP 服务配置。

API Key 使用操作系统提供的安全存储保存，例如 macOS Keychain 或 Windows 凭据管理器，不以明文写入普通配置文件。

用户可以在应用内删除相关配置和任务，也可以卸载应用。操作系统可能按自身规则保留应用数据或安全存储条目，用户可通过系统提供的管理工具清理这些数据。

## 用户指定的外部服务

Tietiezhi 只有在用户配置或明确使用相应功能时，才会连接外部系统：

- 当用户发送聊天消息、运行智能体或获取模型列表时，应用会把完成请求所需的数据和凭据发送到用户配置的模型服务 baseURL。数据可能包括提示词、聊天内容、工具结果及用户选择提供的文件内容。
- 当用户使用语音识别时，录音数据会发送到用户选择的语音识别服务；使用文本润色时，识别结果会发送到用户选择的模型服务。
- 当用户配置并调用 MCP 服务、联网获取工具或其他网络功能时，请求数据会发送到用户指定或明确调用的目标。
- 当用户在设置中点击检查或下载更新时，应用会访问 GitHub Releases，以查询或下载 Tietiezhi 的发布产物。

这些外部服务由用户选择，其数据处理受各服务提供方的隐私政策和使用条款约束。Tietiezhi 项目无法控制第三方服务如何处理数据，用户应在配置前审查相应服务政策。

## 网站与 GitHub

项目官网托管于 GitHub Pages，源代码和发布产物托管于 GitHub。访问官网、仓库或下载发布产物时，GitHub 可能按照其自身隐私政策处理访问日志、IP 地址、Cookie 和账户信息。详见 [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)。

## 儿童隐私

Tietiezhi 不以儿童为目标用户，项目本身不会主动收集或识别用户年龄。

## 政策更新与联系

本政策可能随功能变化而更新，修改记录保留在公开 Git 历史中。如有隐私问题，请在 [GitHub Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) 中联系项目维护者；请勿在公开 Issue 中提交 API Key、聊天内容或其他敏感信息。

---

# Tietiezhi Privacy Policy

Tietiezhi is a local-first, open-source desktop application. The project does not operate a default AI provider and does not include advertising, tracking, telemetry, or analytics. Project maintainers do not automatically collect chat content, task data, API keys, recordings, or local files through the application.

Application settings, tasks, conversations, agent configurations, and workspaces are stored on the user's device. API keys are stored using operating-system secure storage. Data is sent to external systems only when the user configures or invokes the corresponding feature, including user-configured AI providers, speech services, MCP servers, explicitly requested network tools, and GitHub Releases for user-initiated update checks and downloads. Those services process data under their own policies.

For questions, contact the maintainers through [GitHub Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) without posting secrets or other sensitive information.
