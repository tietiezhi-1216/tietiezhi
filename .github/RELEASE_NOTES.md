# Orbit 0.0.3 · 预览版

开放的多模态 AI 平台——每个模型都是一颗卫星。这一版新增基于 GitHub Releases / GitHub Actions 的应用内更新机制：Orbit 可以在设置页检查新版本、下载 CI 产出的 DMG，并在打开安装包前完成 SHA256 校验。

> ⚠️ 预览版，ad-hoc 签名、未公证。打开 `.dmg` → 把 Orbit 拖进「应用程序」→ 首次启动 **右键 → 打开** 绕过 Gatekeeper。当前仅 Apple Silicon · macOS 14+。

## ✨ 本次更新

### 应用内更新（新）
- 「权限 & 关于」新增「软件更新」区域，显示当前版本、CPU 架构和 GitHub Releases 更新源
- 支持从软件内检查最新 GitHub Release，自动匹配当前 macOS 架构对应的 DMG
- 下载完成后校验 `.sha256`，通过后才打开安装包
- 菜单栏与 App 菜单新增「检查更新…」入口，可直接跳转到更新页并开始检查

### GitHub CI/CD 发布链路
- Release workflow 增加 `Info.plist` 版本一致性校验，避免 tag 与应用版本不一致
- 发布产物继续包含 DMG 和 SHA256，并新增 `Orbit-<version>-update.json` 更新清单
- `0.0.3` 版本号与 build number 已同步到应用 bundle metadata

### 关于页修正
- 「关于」中的版本号改为读取 `Info.plist` 的真实版本，不再显示旧的硬编码版本
- 说明文案去掉不必要图标字符，保持 UI 文案稳定

## 📋 环境要求
- macOS 14 (Sonoma) 及以上 · Apple Silicon
- 需授予 **麦克风**（录音）与 **辅助功能**（全局热键 + 模拟 ⌘V 粘贴）权限；可选 **输入监控**

## 🔧 已知限制
- ad-hoc 签名、未公证：首次打开需右键 → 打开
- 应用内更新会下载并打开 DMG；安装仍需用户把 Orbit 拖入「应用程序」完成替换
- API Key 暂以明文存于本地配置（迁移 Keychain 为后续计划）
- 聊天会话当前仅内存保存
