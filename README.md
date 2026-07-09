<div align="center">

<img src="./assets/brand/tietiezhi-mark.png" alt="Tietiezhi" width="160">

# Tietiezhi · 铁铁汁

**Tietiezhi（铁铁汁）—— 万物互联的开放多模态 AI 平台。一个核心，八条触手，连接你所有的设备与模型。**

English · 简体中文

[![CI](https://github.com/tietiezhi-1216/Orbit/actions/workflows/ci.yml/badge.svg)](https://github.com/tietiezhi-1216/Orbit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-f59e0b.svg)](./docs/ROADMAP.md)
[![Server](https://img.shields.io/badge/server-Go%201.26-00ADD8.svg?logo=go&logoColor=white)](./server)
[![Client](https://img.shields.io/badge/client-Flutter-02569B.svg?logo=flutter&logoColor=white)](./app)

</div>

> **Tietiezhi**（铁铁汁，平时叫「铁汁」）像一只章鱼：**一个核心大脑**（可部署到服务器的 Go 单二进制），**八条触手**伸向你的每一台设备和每一个模型。设备之间不再各说各话——它们都连到同一个 hub，彼此发现、互相发消息、协同工作。这就是**万物互联**。

---

## ⚠️ 状态

Tietiezhi 处于**早期开发（pre-alpha）**。仓库由两个曾经独立的项目合并而来：

- **服务端 hub**（原 `tietiezhi` Go 项目）—— OpenAI 兼容 API + Agent 运行时 + 飞书/Telegram 渠道 + 定时任务 + 子代理 + Web 控制台，编译为**单个可执行文件**，直接丢到服务器上跑。
- **多模态客户端**（原 `Orbit` Flutter 项目）—— 聊天、全局语音听写、截图标注、图像/视频生成，覆盖 **Windows / macOS / Linux / Android / iOS / Web**。

两者通过新增的 **Interconnect（万物互联）** 层连接：客户端与设备连上服务端 hub，注册身份、互相发现、点对点/广播发消息。

---

## 🐙 为什么是章鱼

大多数 Agent 软件停在**调用层**：skills、prompt、MCP，全都围着一个文本大模型转。Tietiezhi 想做的是把「多模态」和「多设备」都收进同一个核心：

- **多模态**：文本、图像、语音（ASR/TTS）、视频，每个模型都是一颗可插拔的能力，客户端能听、能看、能说、能画。
- **多设备**：手机、Mac、服务器、群聊机器人，全都连到同一个 hub。一处输入，处处可达；任务可以从一台设备发起、在另一台设备继续。

章鱼的**头**是 hub，**八条触手**是连接出去的设备与模型——这就是 logo 的含义。

## 🧠 理念：*Everything is an Option*

> **每个 issue 都会被接纳。** 好点子也好、小众需求也罢，我们不轻易拒绝，而是尽量**吸收**成设置里的一个 **Option**（带合理默认值）。默认保持精简，控制权留给用户。

---

## 🗂️ 仓库结构

```
tietiezhi/
├── server/                 # Go 后端 hub —— 可部署到服务器的单二进制（万物互联核心）
│   ├── cmd/server/         # 入口
│   ├── internal/
│   │   ├── agent/          # Agent 运行时（工具、记忆、审批、Hook、上下文压缩）
│   │   ├── interconnect/   # 万物互联：设备注册 + 消息路由 hub（WebSocket）
│   │   ├── channel/        # 飞书 / Telegram 渠道
│   │   ├── server/         # HTTP：/health、OpenAI 兼容 /v1/*、管理 API
│   │   ├── llm/ tool/ cron/ subagent/ memory/ mcp/ skill/ ...
│   │   └── webui/          # 内嵌 Web 控制台静态资源
│   ├── web/                # SvelteKit 管理控制台（构建后嵌入二进制）
│   └── go.mod              # module tietiezhi
├── app/                    # Flutter 多模态客户端（Win/macOS/Linux/Android/iOS/Web）
├── apple/                  # 原生 Swift/SwiftUI 参考实现（历史参考，不进 CI 主线）
├── shared/                 # 跨端对齐的规格（模型配置 schema、协议 Wire 定义）
├── assets/brand/           # 章鱼 logo、字标、全端图标源文件
├── docs/                   # ROADMAP、发布签名、协议文档
└── .github/workflows/      # CI：Go 服务端 + Flutter 全端发布
```

---

## 🌐 万物互联（Interconnect）

服务端内置一个 WebSocket **设备 hub**：

| 端点 | 作用 |
|------|------|
| `GET /v1/connect`（WebSocket） | 设备连接并注册，收发消息 |
| `GET /v1/devices` | 列出当前在线设备 |

**消息信封**（JSON）：

```jsonc
{ "type": "hello|presence|message|ping|pong",
  "from": "<deviceID>",
  "to":   "<deviceID 或空=广播>",
  "name": "我的 Mac",
  "payload": { /* 任意业务数据 */ } }
```

流程：设备连上 → 发 `hello` 注册（带 name/平台）→ hub 向所有设备广播 `presence`（在线列表）→ 任意设备发 `message`（指定 `to` 点对点，或留空广播）→ hub 转发。掉线自动从在线列表移除并广播。

客户端侧由 Flutter 的 `InterconnectClient`（`app/lib/core/interconnect.dart`）实现，「互联」页展示在线设备并支持互发消息。

---

## 🚀 快速开始

### 服务端（Go hub）

```bash
cd server
task build           # 构建 Web 控制台 + 编译单二进制到 bin/tietiezhi
./bin/tietiezhi -c ~/.tietiezhi/config.yaml
# 仅编译服务端（跳过前端）：task build:server
# 前后端联调：task dev
```

- 需要 **Go 1.26+**；构建 Web 控制台需 **pnpm**（`task web:build` 会自动装依赖）。
- 运行时数据默认在 `~/.tietiezhi/`。
- 控制台默认监听 `:18178`，浏览器打开即用。

### 客户端（Flutter）

```bash
cd app
flutter pub get
flutter run              # 或 flutter build <macos|windows|linux|apk|ipa|web>
```

在客户端设置里填入服务端地址即可连上 hub，参与万物互联。

---

## 🗺️ Roadmap

见 [**docs/ROADMAP.md**](./docs/ROADMAP.md)。

## 📄 License

[MIT](./LICENSE) © 2026 Tietiezhi contributors.

---

<div align="center">
<sub>🐙 一个核心，八条触手 —— 把每台设备、每个模型都接进同一片海。</sub>
</div>
