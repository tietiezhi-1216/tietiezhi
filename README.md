<div align="center">

# 🛰️ Orbit

**An open, multimodal AI platform for macOS — where every model is a satellite.**

English · [简体中文](./docs/README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-pre--alpha-f59e0b.svg)](./docs/ROADMAP.md)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-000000.svg?logo=apple)](https://www.apple.com/macos/)
[![Swift](https://img.shields.io/badge/Swift-6-F05138.svg?logo=swift&logoColor=white)](https://swift.org)
[![SwiftUI](https://img.shields.io/badge/SwiftUI-0A84FF.svg?logo=swift&logoColor=white)](https://developer.apple.com/xcode/swiftui/)

</div>

> **Orbit** — *like an orbital satellite.* Most agent software stops at the **invocation layer**: skills, prompts, and MCP, all circling a single text LLM. Orbit aims to put text, image, voice (ASR/TTS), and video models into **shared orbit** around one core — so an agent can hear, see, speak, and watch, not just read and write.

---

## ⚠️ Status

Orbit is in **early development (pre-alpha)**. It is a **native macOS app written in Swift / SwiftUI** (it was prototyped on Tauri, then rewritten natively for performance and a true Mac feel). The **first satellite — system-wide voice input — is implemented end to end** (global hotkey → record → ASR → optional LLM polish → paste into the focused app). Stars, ideas, and issues are very welcome.

---

## 🌍 Why Orbit

Today's agent apps — even strong ones — mostly live at the **call layer**: skills/tools, prompts, and MCP, all orbiting a **single text model**. Vision, speech, and video, when present, are bolted on.

A modern workflow is rarely text-only: you *talk*, you *show a screenshot*, you *want it read back*, you *drop in a clip*. Orbit treats **every modality model as a peer satellite** orbiting a shared core that routes data between text, voice, image, and video — so software can actually *hear, see, and speak*.

## 🧠 Philosophy: *Everything is an Option*

> **Every issue gets adopted.** Good idea or niche, we don't reject opinions — we **absorb** them. Where reasonable, each becomes an **Option** (a switch in Settings) with a sane default. The defaults stay minimal; the power stays with the user.

---

## 🎯 First mission: Voice input

Orbit's first satellite is **system-wide dictation** — talk anywhere, get text. We benchmark against **Typeless** and **Openless** and aim to beat them where they fall short:

- **Typeless** is paid → Orbit is **open source & free**.
- **Openless** forces every transcript through an LLM and is slow → Orbit makes LLM polish **optional** and targets **low latency + deep configurability** (model, transport, language, hotkey, templates — all Options).

**How it works today:**

1. **Add a provider** (Settings → 服务商): a dialog for name, protocol, Base URL, API Key. "测试连接" pings `/models`. OpenAI-compatible endpoints and 火山引擎 / 豆包语音 are supported.
2. **Add models** (Settings → 模型): an **ASR** model (e.g. `gpt-4o-transcribe`) and optionally an **LLM** for polishing; pick the active ones.
3. **Set your hotkey** (Settings → 听写): defaults to right ⌘, or record any key. Toggle auto-insert and LLM polish.
4. **Dictate anywhere:** press the hotkey → a recording pill appears bottom-center (✗ cancel · live level · ✓ done) → text is pasted into the focused app.

> The recognized text is delivered by writing it to the clipboard and synthesizing ⌘V (then restoring your clipboard) — fast and reliable for CJK and long text.

---

## 🏗️ Tech stack

| Layer | Choice |
|---|---|
| Language | **Swift 6** |
| UI | **SwiftUI** (with thin AppKit bridges: menu-bar agent, the floating pill `NSPanel`, `NSVisualEffectView` vibrancy) |
| Audio | **AVFoundation** (`AVAudioEngine` capture, downmix + resample) |
| Hotkey | **CGEventTap** (global, keycode-only) |
| Networking | `URLSession` (ASR `multipart` upload · chat completions) |
| Build | **Swift Package Manager** — no Xcode project required |

It's macOS-only by design.

## 🗂️ Project structure

```
Orbit/
├── Package.swift            # SwiftPM manifest (executable target)
├── Info.plist              # bundle id, LSUIElement, usage strings
├── build.sh                # build → assemble .app → sign → run
├── docs/                    # ROADMAP, translated README
└── Sources/Orbit/
    ├── App/                 # entry point, AppDelegate, AppController
    ├── Models/              # Settings (the typed config document)
    ├── Persistence/         # SettingsStore (JSON, debounced)
    ├── Networking/          # provider probes (test / list models)
    ├── Dictation/           # engine, audio, ASR, LLM polish, paste, hotkey, pill
    ├── Support/             # permissions, keycodes, errors
    └── UI/                  # SwiftUI settings window
```

---

## 🚀 Getting started

### Prerequisites

- **macOS 14+** (developed on macOS 26, Apple Silicon)
- A **Swift 6 toolchain** — either full **Xcode**, or just the **Command Line Tools**:
  ```bash
  xcode-select --install
  ```

No Node, no Rust, no Xcode project needed.

### Build & run

```bash
git clone https://github.com/tietiezhi-1216/Orbit.git
cd Orbit
./build.sh run        # compile, assemble Orbit.app, ad-hoc sign, launch
```

Orbit runs as a **menu-bar agent** (no Dock icon): look for the waveform icon in the menu bar; Settings opens automatically on first launch.

Other commands: `./build.sh build` · `./build.sh release` · `./build.sh clean`.

### Permissions

Dictation needs two grants (System Settings → Privacy & Security):

- **Microphone** — to record.
- **Accessibility** — for the global hotkey and to paste the result into the focused app.

The Settings → 权限 & 关于 page shows live status with one-tap grant / open-settings.

Settings are stored as JSON at `~/Library/Application Support/com.orbit.app/config.json`.

---

## 🗺️ Roadmap

| Phase | Theme |
|---|---|
| **M1** | 🎙️ Voice In (ASR) — fast, configurable dictation |
| **M2** | 🔊 Voice Out (TTS) — full voice loop |
| **M3** | 👁️ Vision — image understanding & generation |
| **M4** | 🎬 Video |
| **M5** | 🪐 Orchestration — chain modalities into workflows |
| **M6** | 🌐 Open ecosystem — plugin/model registry, MCP bridge |

**[→ Full roadmap](./docs/ROADMAP.md)**

## 📄 License

[MIT](./LICENSE) © 2026 Orbit contributors.

---

<div align="center">
<sub>Built natively with 🛰️ Swift · SwiftUI · AppKit — bringing every model into orbit.</sub>
</div>
