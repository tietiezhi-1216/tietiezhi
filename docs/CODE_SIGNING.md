# Tietiezhi 代码签名政策

## Code signing policy

Tietiezhi 的正式发布产物由本仓库中的源代码和构建脚本通过 GitHub Actions 自动构建。项目正在申请 SignPath Foundation 的开源代码签名支持；申请获批后，Windows 发布产物将由 SignPath.io 验证来源并签名。

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## 项目角色

- Committer 与 reviewer：[tietiezhi-1216](https://github.com/tietiezhi-1216)
- Approver：[tietiezhi-1216](https://github.com/tietiezhi-1216)

Committer 负责维护源代码和构建配置。外部贡献需要经过 reviewer 审查后方可合并。每个代码签名请求必须由 approver 人工批准。

## 签名范围

- 仅签署由本仓库源代码和受版本控制的构建脚本生成的 Tietiezhi 正式发布产物。
- 不使用本项目的签名权限签署第三方软件或无法验证来源的二进制文件。
- 发布版本号和二进制元数据必须与仓库中的发布配置一致。
- 发布产物通过项目的 GitHub Releases 页面分发。

## 构建与审批

1. 发布版本必须来自受保护的 Git Tag。
2. GitHub Actions 根据仓库内的工作流自动构建发布产物。
3. SignPath.io 验证产物的仓库来源和构建过程。
4. Approver 检查版本、提交和构建结果后，人工批准签名请求。
5. 签名后的产物才作为正式 Windows 安装包发布。

## 安全要求

- 仓库和 SignPath 账户的维护者必须启用多重身份验证。
- 签名密钥由 SignPath 的硬件安全模块管理，不存放在本仓库或 GitHub Secrets 中。
- 如果发现签名权限滥用、供应链异常或发布产物与源代码不一致，维护者将停止发布并配合 SignPath 调查。

有关应用的数据处理方式，请参阅[隐私政策](./PRIVACY.md)。
