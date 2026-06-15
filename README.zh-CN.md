<div align="center">

# 🛰️ Orbit

**一个开放、多模态、去中心化的 Agent 平台 —— 让每个模型都成为一颗卫星。**

[English](./README.md) · 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-f59e0b.svg)](./ROADMAP.md)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri-24C8DB.svg?logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-000000.svg?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-20232A.svg?logo=react&logoColor=61DAFB)](https://react.dev)
[![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-000000.svg)](https://ui.shadcn.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-8b5cf6.svg)](#-参与贡献)

</div>

> **Orbit** —— *寓意「轨道卫星」。* 当下大多数 Agent 软件都止步于**调用层**：Skills、Prompt、MCP 协议，全都围绕一个文本大模型打转。Orbit 把文本、图像、视频、语音（ASR/TTS）、声音模型一起放进围绕同一内核的**共同轨道**——让 Agent 不只是能读会写，更能听、能看、能说、能观。

---

## ⚠️ 项目状态

Orbit 目前处于**早期开发阶段（pre-alpha）**。本仓库当前确立的是**愿景、架构与路线图**。Tauri + Rust + React 脚手架，以及第一个功能——**语音输入**——即将落地。现阶段非常欢迎 Star、点子和 Issue，详见[路线图](./ROADMAP.md)。

---

## 🌍 为什么是 Orbit

今天的「Agent」应用——哪怕是把自家图像、音频模型接进对话循环的优秀产品——几乎都停留在**调用层**。它们暴露的能力无非是：

- **Skills / 工具** —— 模型可调用的预定义函数
- **Prompt** —— 包裹在模型外层的指令
- **MCP** —— 一套挂接外部上下文与工具的协议

而这一切都围绕**单一文本模型**运转。视觉、语音、视频即便存在，也只是临时拼接的功能，而非运行时的一等公民。

**Orbit 选择另一条路。** 真实的工作流极少是纯文本的——你会*说话*、会*甩一张截图*、会*想让它念出来*、会*丢进一段视频*。Orbit 把**每一个模态模型都当作对等的卫星**，围绕一个共享的 Rust 内核运行：内核中的路由器与调度器让数据在文本、语音、图像、视频之间自由流动，从而让「有生命力」的软件真正去解决现实中的工作流。

---

## ✨ Orbit 的不同之处

| | 常见 Agent 应用 | **Orbit** |
|---|---|---|
| **内核** | 单一文本 LLM | 多模态**星座**——文本、视觉、图像生成、声音、视频、ASR/TTS |
| **集成** | Skills · Prompt · MCP（调用层） | 调用层 **+ 模型织网**，跨模态路由 |
| **语音** | 附加功能，往往又慢又收费 | 一等公民**卫星**：快、可本地可云端、高度可配置 |
| **开放性** | 精挑细选、立场鲜明 | **去中心化且开放**——每种意见都能变成一个开关 |
| **可配置** | 旋钮有限 | **「一切皆选项」**——几乎所有东西都是设置面板里的开关 |

---

## 🧠 核心理念：*一切皆选项（Everything is an Option）*

Orbit 的治理模型极度包容：

> **每一个 Issue 都会被采纳。** 无论好坏、无论小众还是热门——我们不拒绝意见，而是**吸纳**它。每条意见都会成为设置面板里的一个**选项（Option）**，用一个 **Switch 开关**收束起来，最终由用户决定。

这正是 Orbit **去中心化**的方式：没有任何单一品味能独断产品方向。默认值保持克制、最小化；掌控权交还用户。互相冲突的需求不必争个你死我活——它们各自作为开关共存。

具体如何落地，见 [参与贡献](#-参与贡献)。

---

## 🏗️ 架构

Orbit 的比喻是字面意义上的：一个**内核**，外加若干在轨运行的**卫星**。

```
                       ╭───────────────────────────────╮
                       │        Orbit 内核  (Rust)       │
                       │   模型路由 · 调度器 ·            │
                       │   选项 / Options 引擎 ·          │
                       │   本地状态与隐私                 │
                       ╰───────────────┬───────────────╯
                   卫星围绕内核运行  ↻  数据自由流动
   ┌──────────┬──────────┬───────────┴───────┬──────────┬──────────┐
   ▼          ▼          ▼                   ▼          ▼          ▼
 ┌──────┐ ┌────────┐ ┌──────────┐      ┌─────────┐ ┌───────┐ ┌─────────┐
 │ 文本 │ │  视觉  │ │  图像     │      │  声音   │ │ 视频  │ │ ASR/TTS │
 │ LLM  │ │  理解  │ │  生成     │      │  理解   │ │ 生成  │ │  语音   │
 └──────┘ └────────┘ └──────────┘      └─────────┘ └───────┘ └─────────┘
                              ▲
                    ┌─────────┴─────────┐
                    │  React + shadcn/ui  │   ← 桌面 UI（Tauri webview）
                    └─────────────────────┘
```

- **内核**负责路由、调度、选项引擎以及隐私 / 状态，使用 **Rust** 编写，追求高速与极小体积。
- 每颗**卫星**都是某个模态的可插拔模型后端（本地或云端）。
- **UI** 是一个 Tauri webview，渲染 **React + shadcn/ui**。

### 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 应用外壳 | **[Tauri](https://tauri.app)** | 体积小、速度快、安全的原生桌面应用，配 Web UI |
| 内核 / 后端 | **[Rust](https://www.rust-lang.org)** | 性能、安全、低延迟的音频与模型路由 |
| UI | **[React](https://react.dev)** | 成熟生态，快速迭代 |
| 组件 | **[shadcn/ui](https://ui.shadcn.com)** | 无障碍、可主题化、可复制进项目的组件 |
| 样式 | Tailwind CSS | 与 shadcn/ui 搭配 |

> 随着应用成长，会陆续引入更多常用 React 库（状态管理、数据请求等）。

---

## 🎯 第一站：语音输入

Orbit 的第一颗卫星是**全局语音输入**——在任何地方说话，得到文本。我们明确对标 **Typeless** 与 **Openless**，并瞄准它们的短板逐一超越：

- **Typeless** 是**收费**模式。 → Orbit **开源且免费**。
- **Openless** 采用「直出直入」+ 大模型转换的模式，但**速度很慢**且**可配置性很差**。 → Orbit 主打**低延迟**与**深度可配置**（模型选择、本地 / 云端、格式化规则、热键、语言、后处理——全部作为选项）。

目标：一套**快、默认隐私优先、可深度定制、且免费**的语音听写。

---

## 🚀 快速开始

> ⚠️ 脚手架正在搭建中。以下是预期的开发步骤，会随首批提交逐步生效。

### 环境要求

- [Rust](https://www.rust-lang.org/tools/install)（stable）
- [Node.js](https://nodejs.org) ≥ 20 与 [pnpm](https://pnpm.io)
- Tauri 所需的平台依赖 —— 见 [Tauri 环境准备指南](https://tauri.app/start/prerequisites/)

### 开发

```bash
git clone https://github.com/tietiezhi-1216/Orbit.git
cd Orbit
pnpm install
pnpm tauri dev      # 以开发模式运行桌面应用
```

### 构建

```bash
pnpm tauri build    # 产出原生发布包
```

---

## 🗺️ 路线图

Orbit 一次发射一颗卫星。概览如下：

| 阶段 | 主题 | 要点 |
|---|---|---|
| **M0** | 地基 | Tauri + Rust + React + shadcn/ui 脚手架 · 选项 / Switch 设置引擎 |
| **M1** | 🎙️ 语音输入（ASR） | 又快又可配置的全局听写 —— 超越 Typeless 与 Openless |
| **M2** | 🔊 语音输出（TTS） | 朗读回复；打通完整语音闭环 |
| **M3** | 👁️ 视觉 | 把图像理解与生成做成卫星 |
| **M4** | 🎬 视频 | 视频理解与生成 |
| **M5** | 🪐 编排 | 在整个星座中把多模态串成真实工作流 |
| **M6** | 🌐 开放生态 | 插件 / 模型注册表、MCP 桥接、社区贡献的卫星 |

**[→ 阅读完整路线图](./ROADMAP.md)**

---

## 🤝 参与贡献

Orbit 建立在「每种意见都能变成一个开关」之上，这让贡献变得格外友好：

1. **提交 Issue** —— 任何点子、需求或吐槽都可以；我们采纳 Issue，而非拒绝它。
2. 只要合理，功能就会以**选项（设置里的一个 Switch）**的形式发布，并带有合理默认值，从不强加于人。
3. **欢迎 PR** —— UI、Rust 内核、模型卫星、文档、翻译，都欢迎。

随着项目成形，正式的 `CONTRIBUTING.md` 与 Issue 模板会陆续补上。

---

## 📄 许可证

[MIT](./LICENSE) © 2026 Orbit contributors。随意使用、fork、发布。

---

<div align="center">
<sub>由 🛰️ Tauri · Rust · React · shadcn/ui 构建 —— 把每个模型都送入轨道。</sub>
</div>
