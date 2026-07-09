<div align="center">

<img src="../assets/brand/tietiezhi-mark.png" alt="Tietiezhi" width="620">

**一个开放的 macOS 多模态 AI 平台 —— 让每个模型都成为一颗卫星。**

[English](../README.md) · 简体中文

[![CI](https://github.com/tietiezhi-1216/Tietiezhi/actions/workflows/ci.yml/badge.svg)](https://github.com/tietiezhi-1216/Tietiezhi/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/tietiezhi-1216/Tietiezhi?include_prereleases&sort=semver&color=0A84FF)](https://github.com/tietiezhi-1216/Tietiezhi/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](../LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-f59e0b.svg)](./ROADMAP.md)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-000000.svg?logo=apple)](https://www.apple.com/macos/)
[![Swift](https://img.shields.io/badge/Swift-6-F05138.svg?logo=swift&logoColor=white)](https://swift.org)
[![SwiftUI](https://img.shields.io/badge/SwiftUI-0A84FF.svg?logo=swift&logoColor=white)](https://developer.apple.com/xcode/swiftui/)

</div>

> **Tietiezhi** —— *像一颗轨道卫星。* 当下大多数 Agent 软件止步于**调用层**：Skills、Prompt、MCP，全都围绕单一的文本大模型打转。Tietiezhi 想把文本、图像、语音（ASR/TTS）、视频模型放进**同一条轨道**，环绕一个内核 —— 让 Agent 不只是读写，还能听、能看、能说、能观察。

---

## ⚠️ 项目状态

Tietiezhi 处于**早期开发（pre-alpha）**。它是一个用 **Swift / SwiftUI 编写的原生 macOS App**（早期曾用 Tauri 原型验证，后为性能与原生质感重写）。**第一颗卫星 —— 系统级语音输入 —— 已端到端打通**（全局热键 → 录音 → 语音识别 → 可选的大模型润色 → 粘贴进当前 App）。欢迎 Star、提 Issue、贡献想法。

---

## 🌍 为什么是 Tietiezhi

今天的 Agent 应用 —— 即便是优秀的那些 —— 大多停留在**调用层**：Skills/工具、Prompt、MCP，全部围绕**单一文本模型**。视觉、语音、视频即便有，也多是临时拼接上去的。

而现代工作流很少是纯文本的：你会*说话*、*甩一张截图*、*想要朗读出来*、*丢进一段视频*。Tietiezhi 把**每个模态模型都当作平等的卫星**，环绕一个负责在文本/语音/图像/视频之间路由数据的内核 —— 让软件真正能*听、看、说*。

## 🧠 理念：*一切皆选项*

> **每个 Issue 都被采纳。** 无论好点子还是小众需求，我们不拒绝意见，而是**吸收**它。在合理的前提下，每个想法都成为设置里的一个**选项（开关）**，带合理的默认值。默认保持精简，控制权交给用户。

---

## 🎯 第一站：语音输入

Tietiezhi 的第一颗卫星是**全局听写** —— 在任何地方说话，得到文字。我们对标 **Typeless** 与 **Openless**，并在它们的短板上发力：

- **Typeless** 收费 → Tietiezhi **开源免费**。
- **Openless** 强制把每段转写都过一遍大模型、且慢 → Tietiezhi 把大模型润色做成**可选**，并主打**低延迟 + 深度可配置**（模型、传输方式、语言、热键、模板，全是选项）。

**当前用法：**

1. **添加服务商**（设置 → 服务商）：弹窗填写 名称、协议、Base URL、API Key，「测试连接」会探测 `/models`。支持 OpenAI 兼容端点与 火山引擎 / 豆包语音。
2. **添加模型**（设置 → 模型）：一个 **ASR** 模型（如 `gpt-4o-transcribe`），以及可选的**大模型**用于润色；选中要用的那个。
3. **设置热键**（设置 → 听写）：默认右 ⌘，也可录制任意键。可开关自动输入与大模型润色。
4. **随处听写：** 按热键 → 底部居中出现录音药丸（✗ 取消 · 实时电平 · ✓ 完成）→ 文本粘贴进当前聚焦的 App。

> 识别结果通过「写入剪贴板 + 模拟 ⌘V + 还原剪贴板」的方式送出 —— 对中文与长文本又快又稳。

---

## ⬇️ 下载

从 [**Releases**](https://github.com/tietiezhi-1216/Tietiezhi/releases) 获取最新构建。

- **仅支持 Apple Silicon**（arm64）· **macOS 14+** —— 不支持 Intel Mac。
- 当前为 **ad-hoc 签名**（尚未公证），首次打开会被 macOS 拦截：**右键 `Tietiezhi.app` → 打开**，再确认。只需一次。
- 打开 `.dmg`，把 **Tietiezhi** 拖进「应用程序」，首次使用时按提示授予 **麦克风** 与 **辅助功能** 权限。
- 后续可在 Tietiezhi 的「权限 & 关于 → 软件更新」中检查 GitHub Releases 更新；下载包会先校验 SHA256 再打开。

想从源码构建？见下方「快速开始」。

---

## 🏗️ 技术栈

| 层 | 选择 |
|---|---|
| 语言 | **Swift 6** |
| 界面 | **SwiftUI**（辅以少量 AppKit：菜单栏代理、悬浮药丸 `NSPanel`、`NSVisualEffectView` 毛玻璃） |
| 音频 | **AVFoundation**（`AVAudioEngine` 采集、降混 + 重采样） |
| 热键 | **CGEventTap**（全局，仅读键码） |
| 网络 | `URLSession`（ASR `multipart` 上传 · chat completions） |
| 构建 | **Swift Package Manager** —— 无需 Xcode 工程 |

设计上仅支持 macOS。

## 🗂️ 目录结构

```
Tietiezhi/
├── Assets/Brand/            # app 图标、README logo、源 SVG
├── Package.swift            # SwiftPM 清单（可执行目标）
├── Info.plist              # bundle id、LSUIElement、权限文案
├── build.sh                # 编译 → 组装 .app → 签名 → 运行
├── docs/                    # 路线图、翻译版 README
└── Sources/Tietiezhi/
    ├── App/                 # 入口、AppDelegate、AppController
    ├── Models/              # Settings（带类型的配置文档）
    ├── Persistence/         # SettingsStore（JSON，防抖写盘）
    ├── Networking/          # 服务商探测（测试 / 拉取模型列表）
    ├── Dictation/           # 引擎、音频、ASR、润色、粘贴、热键、药丸
    ├── Support/             # 权限、键码、错误
    └── UI/                  # SwiftUI 设置窗口
```

---

## 🚀 快速开始

### 前置要求

- **macOS 14+**（在 macOS 26、Apple Silicon 上开发）
- 一套 **Swift 6 工具链** —— 完整 **Xcode**，或仅安装**命令行工具**：
  ```bash
  xcode-select --install
  ```

无需 Node、无需 Rust、无需 Xcode 工程。

### 构建与运行

```bash
git clone https://github.com/tietiezhi-1216/Tietiezhi.git
cd Tietiezhi
./build.sh run        # 编译、组装 Tietiezhi.app、ad-hoc 签名、启动
```

Tietiezhi 以**菜单栏代理**形式运行（无 Dock 图标）：在菜单栏找波形图标；首次启动会自动打开设置窗口。

其他命令：`./build.sh build` · `./build.sh release` · `./build.sh clean`。

### 权限

听写需要两项授权（系统设置 → 隐私与安全性）：

- **麦克风** —— 用于录音。
- **辅助功能** —— 用于全局热键，以及把结果粘贴进当前 App。

设置 → 权限 & 关于 页会实时显示授权状态，并提供一键授权 / 打开系统设置。

配置以 JSON 存于 `~/Library/Application Support/com.tietiezhi.app/config.json`。

---

## 🗺️ 路线图

| 阶段 | 主题 |
|---|---|
| **M1** | 🎙️ 语音输入（ASR）—— 快速、可配置的听写 |
| **M2** | 🔊 语音输出（TTS）—— 闭合语音闭环 |
| **M3** | 👁️ 视觉 —— 图像理解与生成 |
| **M4** | 🎬 视频 |
| **M5** | 🪐 编排 —— 把多模态串成工作流 |
| **M6** | 🌐 开放生态 —— 插件/模型注册表、MCP 桥接 |

**[→ 完整路线图](./ROADMAP.md)**

## 📄 许可证

[MIT](../LICENSE) © 2026 Tietiezhi contributors。

---

<div align="center">
<sub>用 🛰️ Swift · SwiftUI · AppKit 原生打造 —— 让每个模型都入轨。</sub>
</div>
