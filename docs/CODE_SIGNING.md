# Electron 代码签名

桌面安装包由 `.github/workflows/release.yml` 使用 `electron-builder` 构建。

- macOS 生成同时支持 Apple 芯片与 Intel 芯片的 universal DMG/ZIP；Release 必须使用 Developer ID 证书签名并通过 Apple 公证。
- Windows 使用 electron-builder 的 NSIS 目标；正式发布时应配置 Windows 代码签名证书。
- CI 不应保存明文证书或密码，所有签名材料通过 GitHub Actions Secrets 注入。
- Release 流水线会验证双架构、代码签名、公证票据、DMG 校验和，并启动打包后的真实可执行文件完成 Main 模块烟雾测试。
