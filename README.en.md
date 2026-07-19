<div align="center">

<img src="./assets/brand/tietiezhi-mark-transparent.png" alt="Tietiezhi octopus logo" width="120">

# Tietiezhi

**Connect every device with every AI model.**

An open agent network for macOS, Windows, Linux, iOS, Android, servers, and edge nodes.

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md)

[⬇️ Download for macOS / Windows](https://tietiezhi-1216.github.io/tietiezhi/) · [📦 Releases](https://github.com/tietiezhi-1216/tietiezhi/releases/latest) · [🗺️ Roadmap](./docs/ROADMAP.en.md) · [🔒 Privacy](./docs/PRIVACY.md) · [💬 Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) · [⚖️ Apache-2.0](./LICENSE)

</div>

<div align="center">

<img src="./docs/images/tietiezhi-choose-model.jpg" alt="Tietiezhi desktop before a model is selected" width="860">

<sub>Once providers are connected, the user chooses the right model for each new task</sub>

</div>

## What is Tietiezhi?

Tietiezhi is an open-source AI project built around **device × model interconnection**. It does not assume that every task belongs on one computer, inside one chat window, or with one model. Its goal is to connect desktops, mobile clients, standalone server binaries, and edge devices as one collaborative agent network.

Different models excel at different jobs: reasoning, coding, speech, images, video, or low-latency execution. Tietiezhi aims to route the right model, tools, and context to each device and task, so every model can do what it does best instead of asking one model to do everything.

The product available today is a desktop agent for **macOS 13.3+** and **Windows 10/11 (x64)**. The Go server provides the foundation for a Hub and device interconnection. Linux, iOS, Android, and complete cross-device collaboration remain roadmap items and are not shipped clients yet.

## One network for devices and models

| Layer | Foundation today | Direction |
| --- | --- | --- |
| Devices | macOS and Windows desktop app | Linux, iOS, Android, standalone binaries, and edge nodes |
| Hub | Go single-binary server with device registration and message-routing foundations | Device discovery, state sync, and task handoff through a local sidecar or remote Hub |
| Models | Multiple OpenAI-compatible services, text chat, and speech recognition | Capability routing across reasoning, code, speech, image, video, music, and embedding models |
| Agents | Local tools, permissions, Skills, MCP, and isolated workspaces | Cross-device collaboration, delegation, automation, and unified execution history |

Every desktop app, mobile device, server process, or lightweight node should be able to become an endpoint. Every local, private, or cloud model should be able to participate through explicit capabilities and permissions.

## Desktop capabilities available today

| Capability | Available today |
| --- | --- |
| Multiple model providers | Start with Tietiezhi Gateway or add multiple OpenAI-compatible services; sync and switch models freely |
| Local agents | Streaming conversations, multi-step tool use, custom system prompts, and reusable agent profiles |
| Tools and permissions | File, editing, search, shell, and fetch tools with Ask, Auto, and Full Access permission modes |
| Skills and MCP | Import Markdown-based Skills and connect stdio or Streamable HTTP MCP servers |
| Projects and tasks | Local task history and workspaces, pinning, archiving, and isolated Git worktrees for repositories |
| Voice dictation | Global shortcut, speech recognition, model-powered polishing, and text insertion into the active app |
| Local-first security | API keys live in macOS Keychain or Windows Credential Manager; no ads, tracking, or telemetry |
| Native desktop experience | Light and dark themes, in-app updates, and native installers for macOS and Windows |

## Why Tietiezhi?

- **No model is best at everything:** reasoning, coding, speech, and multimodal models should handle the work they suit best.
- **No device has all the context:** computers, phones, servers, and edge nodes should share capabilities when authorized instead of staying isolated.
- **No provider lock-in:** users control base URLs, API keys, models, and deployment locations through open-compatible protocols.
- **Clear permission and data boundaries:** sensitive tools follow explicit policies, and data goes only to services the user configured and invoked.

## Quick start

1. Download the installer for your platform from the [website](https://tietiezhi-1216.github.io/tietiezhi/) or [GitHub Releases](https://github.com/tietiezhi-1216/tietiezhi/releases/latest).
2. Open **Settings → Providers**. Use Tietiezhi Gateway or add your own OpenAI-compatible `baseURL` and API key.
3. Sync and select a model, then create a task. Select a local project directory when the task needs repository access.
4. Add agent profiles, Skills, MCP servers, and tool permissions as needed.

> Tietiezhi never bundles your private API key. Charges and data-processing terms for third-party models are determined by their providers.

## Languages

| Surface | Status |
| --- | --- |
| README | Simplified Chinese, English, Japanese, and Korean |
| Website | Simplified Chinese, English, Japanese, and Korean |
| Desktop app | The current UI is primarily Simplified Chinese; full in-app localization is a near-term goal |

Translation improvements are welcome. Please use this English README as the semantic source for non-Chinese translations.

## Roadmap

Starting from the desktop agent available today, Tietiezhi aims to build a **user-controlled network of devices and models**: devices contribute context and execution environments, models contribute specialized capabilities, and agents connect and orchestrate both within explicit permission boundaries.

Near-term priorities include:

- full desktop localization, plus more reliable installation, signing, updates, and cross-platform behavior;
- a polished end-to-end experience for providers, agent tools, approvals, Skills, and MCP;
- usage and cost insights, and stronger task, project, and workspace management;
- a clear local-sidecar versus remote-server architecture for `server/`, followed by Linux, mobile, and edge-node connections.

Longer-term directions include multi-agent collaboration, integrations with Codex / Claude Code / opencode, multimodal models, visual workflows, and automation. See the [full roadmap](./docs/ROADMAP.en.md) for status and boundaries.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`desktop/`](./desktop) | Main desktop app: Tauri 2 + Rust + React 19 + TypeScript + shadcn/ui |
| [`server/`](./server) | Go agent hub: OpenAI-compatible API, channels, memory, scheduling, and an interconnect foundation |
| [`website/`](./website) | Multilingual website and download page published with GitHub Pages |
| [`shared/`](./shared) | Reserved source of truth for cross-client protocols and configuration |
| [`assets/brand/`](./assets/brand) | Logo, mascot, and application icon sources |
| [`docs/`](./docs) | Roadmap, privacy policy, and code-signing documents |

## Development

### Desktop

Prerequisites: Node.js 22+, pnpm 9+, Rust stable, and the Tauri system dependencies for your platform.

```bash
cd desktop
pnpm install
pnpm tauri dev
```

Useful checks:

```bash
pnpm typecheck
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

### Server

The server requires Go 1.26+ and [Task](https://taskfile.dev/).

```bash
cd server
task build
task test
```

Read [`CLAUDE.md`](./CLAUDE.md) before contributing; it contains the engineering conventions for every contributor and coding agent in this repository. Bug reports, ideas, and roadmap discussions are welcome in [Issues](https://github.com/tietiezhi-1216/tietiezhi/issues). Never post API keys or other secrets in public issues.

## License and code signing

Copyright © 2026 Tietiezhi. Released under the [Apache License 2.0](./LICENSE).

The project is applying for SignPath Foundation support for official Windows code signing. See the [code-signing policy](./docs/CODE_SIGNING.md) and [privacy policy](./docs/PRIVACY.md).
