<div align="center">

# 🛰️ Orbit

**An open, multimodal, decentralized agent platform — where every model is a satellite.**

English · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-f59e0b.svg)](./ROADMAP.md)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri-24C8DB.svg?logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-000000.svg?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React-20232A.svg?logo=react&logoColor=61DAFB)](https://react.dev)
[![shadcn/ui](https://img.shields.io/badge/shadcn%2Fui-000000.svg)](https://ui.shadcn.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-8b5cf6.svg)](#-contributing)

</div>

> **Orbit** — *like an orbital satellite.* Most agent software today stops at the **invocation layer**: Skills, prompts, and the MCP protocol, all circling a single text LLM. Orbit puts text, image, video, voice (ASR/TTS), and audio models into **shared orbit** around one core — so an agent can hear, see, speak, and watch, not just read and write.

---

## ⚠️ Project Status

Orbit is in **early development (pre-alpha)**. This repository currently defines the **vision, architecture, and roadmap**. The Tauri + Rust + React scaffold and the first feature — **voice input** — are landing next. Stars, ideas, and issues are very welcome at this stage; see the [Roadmap](./ROADMAP.md).

---

## 🌍 Why Orbit

Today's "agent" apps — even strong ones that wire their own image or audio models into a chat loop — almost all live at the **call layer**. They expose:

- **Skills / tools** — predefined functions the model can call
- **Prompts** — instructions wrapped around the model
- **MCP** — a protocol to attach external context and tools

All of these orbit a **single text model**. Vision, speech, and video, when present, are bolted on as one-off features rather than first-class citizens of the runtime.

**Orbit takes a different stance.** A modern workflow is rarely text-only — you *talk*, you *show a screenshot*, you *want it read back*, you *drop in a clip*. Orbit treats **every modality model as a peer satellite** orbiting a shared Rust core: a router and scheduler that move data fluidly between text, voice, image, and video, so software that feels **alive** can actually solve real-world workflows.

---

## ✨ What Makes Orbit Different

| | Typical agent apps | **Orbit** |
|---|---|---|
| **Core** | One text LLM | A multimodal **constellation** — text, vision, image-gen, audio, video, ASR/TTS |
| **Integration** | Skills · Prompt · MCP (call layer) | Call layer **+ a model fabric** that routes across modalities |
| **Voice** | An add-on, often slow / paid | A first-class **satellite**: fast, local-or-cloud, fully configurable |
| **Openness** | Curated, opinionated | **Decentralized & open** — every opinion can become a toggle |
| **Config** | Limited knobs | "**Everything is an Option**" — settings-panel switches for almost everything |

---

## 🧠 The Philosophy: *Everything is an Option*

Orbit's governance model is radically inclusive:

> **Every issue gets adopted.** Good idea or bad, popular or niche — we don't reject opinions, we **absorb** them. Each one becomes an **Option** in the settings panel, gated behind a **Switch**, and the user decides.

This keeps Orbit **decentralized**: no single taste dictates the product. The defaults stay sane and minimal; the power stays with the user. Conflicting requests don't fight — they coexist as toggles.

See [`CONTRIBUTING`](#-contributing) for how this turns into practice.

---

## 🏗️ Architecture

Orbit's metaphor is literal: a **core** with **satellites** in orbit.

```
                       ╭───────────────────────────────╮
                       │        Orbit Core  (Rust)      │
                       │  Model Router · Scheduler ·     │
                       │  Settings/Options Engine ·      │
                       │  Local State & Privacy          │
                       ╰───────────────┬───────────────╯
                  satellites orbit the core  ↻  data flows freely
   ┌──────────┬──────────┬───────────┴───────┬──────────┬──────────┐
   ▼          ▼          ▼                   ▼          ▼          ▼
 ┌──────┐ ┌────────┐ ┌──────────┐      ┌─────────┐ ┌───────┐ ┌─────────┐
 │ Text │ │ Vision │ │  Image   │      │  Audio  │ │ Video │ │ ASR/TTS │
 │ LLM  │ │under-  │ │   gen    │      │under-   │ │  gen  │ │  voice  │
 │      │ │stand   │ │          │      │stand    │ │       │ │         │
 └──────┘ └────────┘ └──────────┘      └─────────┘ └───────┘ └─────────┘
                              ▲
                    ┌─────────┴─────────┐
                    │   React + shadcn/ui   │   ← desktop UI (Tauri webview)
                    └───────────────────────┘
```

- The **Core** owns routing, scheduling, the Options engine, and privacy/state — written in **Rust** for speed and a small footprint.
- Each **satellite** is a pluggable model backend (local or cloud) for a modality.
- The **UI** is a Tauri webview rendering **React + shadcn/ui**.

### Tech Stack

| Layer | Choice | Why |
|---|---|---|
| App shell | **[Tauri](https://tauri.app)** | Tiny, fast, secure native desktop apps with a web UI |
| Core / backend | **[Rust](https://www.rust-lang.org)** | Performance, safety, low-latency audio & model routing |
| UI | **[React](https://react.dev)** | Mature ecosystem, fast iteration |
| Components | **[shadcn/ui](https://ui.shadcn.com)** | Accessible, themeable, copy-in components |
| Styling | Tailwind CSS | Pairs with shadcn/ui |

> More common React libraries (state, data-fetching, etc.) will be added as the app grows.

---

## 🎯 First Mission: Voice Input

Orbit's first satellite is **system-wide voice input** — talk anywhere, get text. We are explicitly benchmarking against **Typeless** and **Openless**, and aiming to beat them on the axes where they fall short:

- **Typeless** is **paid**. → Orbit is **open source & free**.
- **Openless** does raw speech-to-text passed through an LLM for cleanup — but it is **slow** and **poorly configurable**. → Orbit targets **low latency** and **deep configurability** (model choice, local vs cloud, formatting rules, hotkeys, language, post-processing — all as Options).

The goal: dictation that is **fast, private-by-default, hackable, and free**.

---

## 🚀 Getting Started

> ⚠️ The scaffold is being set up. These are the intended developer steps and will become live as the first commits land.

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Node.js](https://nodejs.org) ≥ 20 and [pnpm](https://pnpm.io)
- Platform deps for Tauri — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

### Develop

```bash
git clone https://github.com/tietiezhi-1216/Orbit.git
cd Orbit
pnpm install
pnpm tauri dev      # run the desktop app in dev mode
```

### Build

```bash
pnpm tauri build    # produce a native release bundle
```

---

## 🗺️ Roadmap

Orbit grows one satellite at a time. High level:

| Phase | Theme | Highlights |
|---|---|---|
| **M0** | Foundation | Tauri + Rust + React + shadcn/ui scaffold · the Options/Switch settings engine |
| **M1** | 🎙️ Voice In (ASR) | Fast, configurable system-wide dictation — beat Typeless & Openless |
| **M2** | 🔊 Voice Out (TTS) | Speak responses; full voice loop |
| **M3** | 👁️ Vision | Image understanding & generation as satellites |
| **M4** | 🎬 Video | Video understanding & generation |
| **M5** | 🪐 Orchestration | Chain modalities into real workflows across the constellation |
| **M6** | 🌐 Open Ecosystem | Plugin/model registry, MCP bridge, community-contributed satellites |

**[→ Read the full Roadmap](./ROADMAP.md)**

---

## 🤝 Contributing

Orbit is built on *"every opinion can become a toggle."* That makes contributing unusually welcoming:

1. **Open an issue** for any idea, request, or complaint — we adopt issues rather than reject them.
2. Where reasonable, a feature ships as an **Option** (a Switch in settings) with a sensible default, so it never forces itself on anyone.
3. **PRs welcome** — UI, Rust core, model satellites, docs, translations.

A formal `CONTRIBUTING.md` and issue templates are coming as the project takes shape.

---

## 📄 License

[MIT](./LICENSE) © 2026 Orbit contributors. Use it, fork it, ship it.

---

<div align="center">
<sub>Built with 🛰️ Tauri · Rust · React · shadcn/ui — bringing every model into orbit.</sub>
</div>
