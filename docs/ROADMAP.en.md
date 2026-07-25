# Tietiezhi Roadmap

[简体中文](./ROADMAP.md) · [English](./ROADMAP.en.md)

> Last organized in July 2026. This roadmap communicates direction, not promised release dates. Priorities may change with stability needs, user feedback, and maintainer capacity.

## Product vision

Tietiezhi is built around **device × model interconnection**. Its long-term goal is a user-controlled agent network connecting macOS, Windows, Linux, iOS, Android, standalone server binaries, and edge nodes. Devices contribute context and execution environments; specialized models contribute reasoning, code, speech, and multimodal capabilities; agents select, route, and coordinate them within explicit permission boundaries.

Three principles guide that direction:

1. **Every device can be a node:** desktop, mobile, server, and edge devices can contribute context or execution capabilities.
2. **Every model plays to its strengths:** select models by capability, cost, latency, and privacy instead of asking one model to do everything.
3. **Local first:** keep tasks, workspaces, and credentials on the user's device whenever practical.
4. **Open and controlled:** avoid provider lock-in, use open protocols, and keep high-impact operations explicitly scoped and inspectable.

## Current delivery boundaries

| Component | Status |
| --- | --- |
| macOS / Windows desktop agent | Shipped and under active development |
| Go single-binary Hub | Agent, channel, memory, scheduling, and interconnect modules exist; productization is ongoing |
| Linux / iOS / Android clients | Planned, not shipped |
| Cross-device desktop/Hub collaboration | Remote Cores, discovery, desktop node registration, and baseline calls are available; mobile and approval coverage are still evolving |
| Multimodal capability routing | Text, speech recognition, and image/video generation in Create are available today; music, embeddings, and other modalities remain planned |

## Completed: desktop agent foundation

- [x] A unified Tauri 2 + Rust + React 19 desktop stack for macOS and Windows
- [x] Tietiezhi Gateway and multiple OpenAI-compatible providers, with model sync and switching
- [x] OpenAI-compatible streaming chat and multi-step tool use
- [x] Built-in file read/write/edit, directory, glob, search, shell, fetch, and Skill tools
- [x] Ask, Auto, and Full Access tool-permission modes
- [x] Reusable agent profiles with system-prompt, tool, and model overrides
- [x] Create, import, enable, disable, and load Markdown-based Skills on demand
- [x] stdio and Streamable HTTP MCP connections
- [x] Local task persistence, pinning, archiving, and restoring
- [x] Work and Code modes with shared context, distinct tool/result surfaces, isolated spaces, and explicit artifact handoff
- [x] Tietiezhi device center, remote Core management, desktop node registration, discovery, and baseline capability calls
- [x] Tietiezhi control center, dedicated Home, editable Markdown memory, file-oriented secure secret references, and dedicated Skill/MCP/tool assignment
- [x] Global voice dictation, speech recognition, model polishing, and text insertion
- [x] Create image/video generation, reference-image input, task progress, and local asset management
- [x] Light/dark themes, Windows/macOS CI, releases, and in-app updates
- [x] A multilingual website and Chinese, English, Japanese, and Korean READMEs

## Near term: product quality and localization

- [ ] Introduce desktop i18n with Simplified Chinese and English first, followed by Japanese and Korean
- [ ] Improve onboarding, provider setup, model capability detection, and error recovery
- [ ] Refine tool history, approval flows, long-running cancellation, and retry behavior
- [ ] Add stronger Skills / MCP validation, diagnostics, import/export, and examples
- [ ] Improve task, project, and workspace search, organization, backup, and migration
- [ ] Add understandable model usage, latency, and cost insights
- [ ] Stabilize the macOS signing/notarization and trusted Windows signing release chain
- [ ] Establish end-to-end coverage, accessibility checks, and performance baselines for critical paths

## Mid term: connect models, tools, and devices

- [x] Establish a local-first boundary with an embedded Rust Core and optional remote Cores
- [x] Connect the desktop app to `server/internal/interconnect/` for device registration, discovery, and message routing
- [ ] Expose a user-controlled local compatible endpoint to Codex, Claude Code, opencode, and similar developer tools
- [ ] Continue expanding `shared/interconnect/` and create portable Agent, Skill, and MCP configuration
- [ ] Surface channels, scheduled tasks, long-term memory, and remote agents in one desktop experience

## Long term: a composable agent ecosystem

### Multi-agent and multiple entry points

- [ ] Agent delegation, specialization, progress tracking, and result synthesis
- [ ] Shared tasks between the desktop app and team channels such as Feishu and Telegram
- [ ] A lightweight “chat capsule” and cross-application context entry points

### Multimodal work

- [ ] A unified capability and selection model for text, speech, image, video, music, and embedding models
- [ ] Safe local preprocessing, preview, and controlled upload for files and media
- [ ] Clear usage, cost, and privacy signals for every modality

### Workflows and automation

- [ ] A visual node editor for composing models, tools, and agents
- [ ] Scripted or AI-generated automation flows
- [ ] Reusable templates for screenshots, content production, short-form video, e-commerce, and other scenarios
- [ ] Scheduling, event triggers, approvals, and execution history

## Key architecture questions

These choices affect the desktop/server boundary and require design work before implementation:

1. How should the existing Go Hub migrate toward an embeddable and standalone Rust Core without breaking protocol compatibility?
2. How should local and server agents share tasks, memory, tool permissions, and audit history?
3. How should multimodal files retain clear data boundaries between the device, model providers, and a remote Hub?
4. Which stable protocols belong in `shared/` so the desktop and server do not become tightly coupled?

## Not currently in scope

- Linux, iOS, Android, and Web clients have no current delivery plan. The architecture does not rule them out, but development resources are focused on macOS and Windows.
- Long-term items are not claims about features already shipped in the desktop app. A module skeleton under `server/internal/` does not mean that its desktop integration or product experience is complete.

Use [GitHub Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) to discuss priorities, use cases, and design proposals.
