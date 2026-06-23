# 🗺️ Orbit Roadmap

English · [简体中文](#-orbit-路线图中文)

> Orbit grows **one satellite at a time**. The core comes first; each modality is launched into orbit only once it can stand on its own. Milestones are directional, not dated — sequencing matters more than deadlines this early.

Legend: 🔲 planned · 🚧 in progress · ✅ done

---

## M0 · Foundation 🚧

The launchpad. Nothing orbits until the core exists.

- ✅ Native macOS app scaffold — Swift + SwiftUI + AppKit, built with Swift Package Manager (no Xcode project)
- 🔲 **Options Engine** — the heart of *"everything is an Option"*: a typed settings registry where any feature can register a switch with a default, persisted locally
- 🔲 Settings panel UI with searchable, categorized toggles
- 🔲 Model backend abstraction (the "satellite socket"): a trait/interface a modality model plugs into (local or cloud, configurable)
- 🔲 Privacy & local-state foundation (secrets, model keys, on-device data)

## M1 · 🎙️ Voice Input — ASR 🚧

Orbit's **first mission**. System-wide dictation that beats the incumbents.

- ✅ Global hotkey capture (single right-⌘ or any recorded key) + audio pipeline (AVAudioEngine)
- ✅ Pluggable ASR backends via the provider system — OpenAI-compatible **HTTP** today; **Realtime WebSocket** + 火山引擎 streaming next
- ✅ Optional LLM post-processing (polish) — toggleable, *not* mandatory like Openless
- ✅ Reliable insertion via clipboard paste (fast for CJK / long text)
- ✅ Deep configurability as Options: provider, model, transport, language, hotkey, auto-insert, prompt templates + insertion placeholder
- 🔲 Benchmark suite vs **Typeless** & **Openless** (latency, accuracy, configurability) published in-repo
- 🔲 End-to-end runtime validation + local (whisper.cpp-class) ASR backend

## M2 · 🔊 Voice Output — TTS 🔲

Close the voice loop.

- 🔲 Pluggable TTS backends (local + cloud)
- 🔲 Read-back of agent output; voice selection, speed, language as Options
- 🔲 Full hands-free **talk ⇄ listen** conversation mode

## M3 · 👁️ Vision 🔲

Let Orbit see and draw.

- 🔲 Image **understanding** satellite (screenshots, files, drag-and-drop, screen region capture)
- 🔲 Image **generation** satellite
- 🔲 Vision results flow into the same routing fabric as text & voice

## M4 · 🎬 Video 🔲

Time-based modalities.

- 🔲 Video **understanding** (clips, screen recordings)
- 🔲 Video **generation**
- 🔲 Streaming/long-media handling in the core scheduler

## M5 · 🪐 Orchestration 🔲

The actual *orbit* — satellites working together.

- 🔲 Cross-modal workflows (e.g. *speak → transcribe → reason → generate image → read result back*)
- 🔲 Visual / declarative workflow builder, every step a configurable node
- 🔲 Scheduler upgrades: parallel satellites, fan-out/fan-in, cancellation
- 🔲 Reusable workflow templates

## M6 · 🌐 Open Ecosystem 🔲

Decentralize the constellation.

- 🔲 Plugin / extension API for community-contributed satellites
- 🔲 Model & plugin **registry** (decentralized, self-hostable)
- 🔲 **MCP bridge** — interoperate with the existing call-layer ecosystem rather than replace it
- 🔲 Community Options: the "every issue becomes a toggle" pipeline, formalized with templates & governance docs

---

## How we decide what's next

Orbit is **decentralized by design**. Priority emerges from issues and contributions, not a closed roadmap. When opinions conflict, the answer is usually *"both — as Options."* Open an issue to push something up the list.

---
---

# 🗺️ Orbit 路线图（中文）

[English](#-orbit-roadmap) · 简体中文

> Orbit **一次发射一颗卫星**。内核优先；每个模态只有在能独立运转后才送入轨道。里程碑表示方向而非日期——在如此早期，顺序比截止时间更重要。

图例：🔲 计划中 · 🚧 进行中 · ✅ 已完成

---

## M0 · 地基 🚧

发射台。内核不存在，就没有任何东西能入轨。

- ✅ 原生 macOS App 脚手架 —— Swift + SwiftUI + AppKit，用 Swift Package Manager 构建（无需 Xcode 工程）
- 🔲 **选项引擎（Options Engine）** —— 「一切皆选项」的心脏：一个带类型的设置注册表，任何功能都能注册一个带默认值的开关并本地持久化
- 🔲 设置面板 UI，支持搜索、分类的开关
- 🔲 模型后端抽象（「卫星插槽」）：模态模型插入的 trait / 接口（本地或云端，可配置）
- 🔲 隐私与本地状态地基（密钥、模型 Key、端侧数据）

## M1 · 🎙️ 语音输入 —— ASR 🚧

Orbit 的**第一站**。超越现有产品的全局听写。

- ✅ 全局热键捕获（单独右 ⌘ 或任意录制按键）+ 音频管线（AVAudioEngine）
- ✅ 经由 provider 系统的可插拔 ASR 后端 —— 当前 OpenAI 兼容 **HTTP**；**Realtime WebSocket** 与 火山引擎 流式为下一步
- ✅ 可选的 LLM 后处理（润色）—— 可开关，而非像 Openless 那样强制
- ✅ 可靠的文本插入：剪贴板粘贴（对中文/长文本又快又稳）
- ✅ 作为选项的深度可配置：provider、模型、传输方式、语言、热键、自动输入、提示词模板 + 插入占位符
- 🔲 对标 **Typeless** 与 **Openless** 的基准测试套件（延迟、准确率、可配置性），在仓库内公开
- 🔲 端到端真机验证 + 本地（whisper.cpp 一类）ASR 后端

## M2 · 🔊 语音输出 —— TTS 🔲

闭合语音闭环。

- 🔲 可插拔 TTS 后端（本地 + 云端）
- 🔲 朗读 Agent 输出；音色、语速、语言作为选项
- 🔲 完全解放双手的 **说 ⇄ 听** 对话模式

## M3 · 👁️ 视觉 🔲

让 Orbit 能看、能画。

- 🔲 图像**理解**卫星（截图、文件、拖拽、屏幕区域捕获）
- 🔲 图像**生成**卫星
- 🔲 视觉结果汇入与文本、语音相同的路由织网

## M4 · 🎬 视频 🔲

引入基于时间的模态。

- 🔲 视频**理解**（片段、录屏）
- 🔲 视频**生成**
- 🔲 内核调度器对流式 / 长媒体的处理

## M5 · 🪐 编排 🔲

真正的*轨道*——卫星协同工作。

- 🔲 跨模态工作流（如：*说话 → 转写 → 推理 → 生成图像 → 朗读结果*）
- 🔲 可视化 / 声明式工作流编辑器，每一步都是可配置节点
- 🔲 调度器升级：并行卫星、扇出 / 扇入、可取消
- 🔲 可复用的工作流模板

## M6 · 🌐 开放生态 🔲

让星座去中心化。

- 🔲 面向社区贡献卫星的插件 / 扩展 API
- 🔲 模型与插件**注册表**（去中心化、可自托管）
- 🔲 **MCP 桥接** —— 与现有调用层生态互通，而非取而代之
- 🔲 社区选项：把「每个 Issue 都变成一个开关」的流程，用模板与治理文档正式固化

---

## 我们如何决定下一步

Orbit **从设计上就是去中心化的**。优先级源于 Issue 与贡献，而非一份封闭的路线图。当意见冲突时，答案通常是「都要——作为选项」。提一个 Issue，把你想要的东西顶上来。
