//  ChatDetailView.swift
//  The chat transcript + composer. Streams assistant replies from the active
//  LLM; shows helpful empty states when there's no conversation or no model.

import SwiftUI
import AppKit
import AVKit
import UniformTypeIdentifiers

struct ChatDetailView: View {
    @EnvironmentObject var chat: ChatStore
    @EnvironmentObject private var store: SettingsStore
    @EnvironmentObject private var app: AppController

    let openSettings: () -> Void

    @State private var draft = ""
    /// Auto-grown height of the AppKit input field.
    @State private var inputHeight: CGFloat = 24
    /// Images attached to the next message (multimodal input).
    @State private var attachments: [URL] = []
    /// Reasoning-effort probe state.
    @State private var probing = false
    @State private var probeMessage: String?

    /// True only when a stream is active for the *currently shown* conversation.
    private var streamingHere: Bool {
        guard let id = chat.selectedID else { return false }
        return chat.isStreaming(id)
    }

    private var canSend: Bool {
        (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !streamingHere && chat.hasLLM
    }

    private var chatModels: [ModelConfig] {
        store.settings.chatModels
    }

    /// Channels (渠道商) that have at least one chat model, in settings order.
    /// The model picker groups by these so it stays legible as channels grow.
    private var chatProviders: [Provider] {
        store.settings.providers.filter { p in
            chatModels.contains { $0.providerID == p.id }
        }
    }

    private func chatModels(in provider: Provider) -> [ModelConfig] {
        chatModels.filter { $0.providerID == provider.id }
    }

    private var selectedLLM: ModelConfig? {
        store.settings.llmModel
    }

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 44)
            if let convo = chat.selected, !convo.messages.isEmpty {
                transcript(convo)
            } else {
                emptyState
            }
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { ensureValidLLMSelection() }
        .onChange(of: store.settings.models) { _, _ in ensureValidLLMSelection() }
    }

    // MARK: - Transcript

    private func transcript(_ convo: Conversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(convo.messages) { message in
                        Group {
                            if message.role == .tool {
                                ToolResultRow(message: message)
                            } else {
                                MessageRow(message: message,
                                           streaming: chat.isStreamingMessage(message.id),
                                           startedAt: chat.streamStartedAt,
                                           liveTokens: chat.liveOutputTokens)
                            }
                        }
                        .id(message.id)
                    }

                    // Orbit's satellite mark lives HERE — below every message, not
                    // under each reply. Resting when idle; it animates + shows the
                    // elapsed timer / live token count only while a reply streams.
                    GenerationStatus(streaming: streamingHere,
                                     startedAt: chat.streamStartedAt,
                                     liveTokens: chat.liveOutputTokens)
                        .id("gen-status")
                }
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 16)
                .background(ScrollerStyler())
            }
            .onChange(of: convo.messages.last?.content) { _, _ in
                scrollToBottom(proxy)
            }
            .onChange(of: convo.messages.count) { _, _ in
                scrollToBottom(proxy)
            }
            // Opening / switching a conversation must land at the newest message.
            .onChange(of: chat.selectedID) { _, _ in
                scrollToBottom(proxy, animated: false)
            }
            .onAppear {
                // First layout: jump to the bottom without an animated sweep.
                DispatchQueue.main.async { scrollToBottom(proxy, animated: false) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Scroll to the very bottom — the satellite mark ("gen-status") sits below the
    /// last message, so target it (targeting the last message alone stops short).
    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        func go() { proxy.scrollTo("gen-status", anchor: .bottom) }
        if animated {
            withAnimation(.easeOut(duration: 0.15)) { go() }
        } else {
            go()
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 10) {
            if chatModels.isEmpty {
                Text("尚未配置大模型")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                Text("进入「设置 → 渠道商」添加一个渠道商，加载模型后选为当前大模型。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    app.openSettingsWorkspace(.providers)
                } label: {
                    Label("配置渠道商", systemImage: "server.rack")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .padding(.top, 8)
            } else if !chat.hasLLM {
                Text("请选择大模型")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                Text("在下方对话框选择本次对话要使用的 LLM。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else {
                Text("开始一个新对话")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                Text("在下方选择模型并输入问题，Orbit 会在这里生成回复。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
    }

    // MARK: - Composer

    private var composer: some View {
        VStack(spacing: 0) {
            Divider()
            // One rounded card: attachments + text on top, controls in a row along
            // the bottom (attach · agent · model · effort … send).
            VStack(alignment: .leading, spacing: 8) {
                if !attachments.isEmpty { attachmentStrip }

                // AppKit-backed input: IME-aware Return (composition confirm never
                // sends), native image / file paste, auto-grow. Drag-drop stays on
                // the SwiftUI card below.
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(chat.hasLLM ? "给 Orbit 发消息…（可直接粘贴 / 拖入图片）" : "先选择一个大模型…")
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 4).padding(.top, 8)
                            .allowsHitTesting(false)
                    }
                    ChatComposerField(text: $draft, height: $inputHeight,
                                      minHeight: 24, maxHeight: 200,
                                      onSubmit: { if canSend { send() } },
                                      onAttach: { attachments.append(contentsOf: $0) })
                        .frame(height: inputHeight)
                }
                .onDrop(of: [.image, .fileURL], isTargeted: nil) { providers in
                    addAttachments(providers); return true
                }

                HStack(spacing: 8) {
                    if selectedLLM?.llmCapabilities.multimodal == true {
                        Button { pickImages() } label: {
                            Image(systemName: "paperclip").font(.system(size: 14))
                        }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("添加图片（也可直接粘贴 / 拖入）")
                    }
                    agentSelector
                    modelSelector
                    if let selectedLLM { capabilityControls(for: selectedLLM) }
                    Spacer(minLength: 0)

                    if let selectedLLM, let cid = chat.selectedID {
                        ContextRing(used: chat.contextTokens(for: cid),
                                    limit: ContextRing.contextWindow(for: selectedLLM.model))
                    }

                    if streamingHere {
                        Button { chat.cancel() } label: {
                            Image(systemName: "stop.fill")
                                .foregroundStyle(.primary)
                                .frame(width: 30, height: 30)
                                .background(Circle().fill(Color.secondary.opacity(0.22)))
                        }
                        .buttonStyle(.plain).help("停止")
                    } else {
                        Button { send() } label: {
                            Image(systemName: "arrow.up")
                                .fontWeight(.bold).foregroundStyle(.white)
                                .frame(width: 30, height: 30)
                                .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.4)))
                        }
                        .buttonStyle(.plain).disabled(!canSend)
                        .keyboardShortcut(.return, modifiers: .command)
                        .help(chat.hasLLM ? "发送（回车）" : "先选择大模型")
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.18)))
            .padding(.horizontal, 22)
            .padding(.vertical, 12)
        }
        .background(.bar)
        .alert("思考档探测", isPresented: Binding(
            get: { probeMessage != nil },
            set: { if !$0 { probeMessage = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: { Text(probeMessage ?? "") }
    }

    /// Thinking-effort control — only shown for models that support reasoning.
    /// Tools are configured per-agent (in the 智能体 editor), not here; when the
    /// current model can't call tools, the agent switcher shows a hint instead.
    @ViewBuilder
    private func capabilityControls(for model: ModelConfig) -> some View {
        let effort = model.reasoningEffort
        if model.llmCapabilities.thinking {
            let toggleSet = ReasoningLevels.sorted(Array(Set(ReasoningLevels.candidates + model.reasoningLevels)))
            Menu {
                Section("Thinking effort") {
                    effortButton("", for: model, current: effort)   // Off
                    ForEach(model.availableEfforts, id: \.self) { level in
                        effortButton(level, for: model, current: effort)
                    }
                }
                Divider()
                Menu("可选档位") {
                    ForEach(toggleSet, id: \.self) { level in
                        Button { toggleLevel(level, for: model) } label: {
                            HStack {
                                Text(ReasoningLevels.displayName(level))
                                if model.availableEfforts.contains(level) { Image(systemName: "checkmark") }
                            }
                        }
                    }
                    Divider()
                    Button("添加自定义…") { promptCustomLevel(for: model) }
                }
                Button(probing ? "探测中…" : "探测支持的档位") { probeReasoning(for: model) }
                    .disabled(probing)
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "brain").font(.system(size: 13))
                    if !effort.isEmpty {
                        Text(ReasoningLevels.displayName(effort)).font(.caption2.weight(.semibold))
                    }
                }
                .foregroundStyle(!effort.isEmpty ? Color.accentColor : Color.secondary)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("思考等级（每个模型记住自己的设置）")
        }
    }

    /// The current chat model can't run tools (not tool-flagged, or on a wire the
    /// tool loop doesn't support). Mirrors ChatStore's tool gate.
    private var modelCannotCallTools: Bool {
        guard let model = selectedLLM else { return false }
        let wireSupportsTools = store.settings.resolve(model)
            .map { $0.wire == .openAIChat || $0.wire == .anthropicMessages } ?? false
        return !(model.llmCapabilities.toolCalling && wireSupportsTools)
    }

    /// True when the active agent has tools enabled but the model can't call them.
    private var toolsUnavailable: Bool {
        guard let agent = store.settings.activeAgent, !agent.enabledTools.isEmpty else { return false }
        return modelCannotCallTools
    }

    private func pickImages() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.image]
        panel.prompt = "添加"
        if panel.runModal() == .OK { attachments.append(contentsOf: panel.urls) }
    }

    /// Attach images / files pasted or dropped into the composer. Pasted image
    /// data (e.g. a screenshot) is written to a file so it can be sent + shown.
    private func addAttachments(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.canLoadObject(ofClass: NSImage.self) {
                _ = provider.loadObject(ofClass: NSImage.self) { object, _ in
                    guard let image = object as? NSImage, let url = Self.saveImage(image) else { return }
                    DispatchQueue.main.async { attachments.append(url) }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { item, _ in
                    let url: URL? = (item as? URL) ?? (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                    if let url { DispatchQueue.main.async { attachments.append(url) } }
                }
            }
        }
    }

    /// Persist a pasted/dropped image as a PNG under ~/.orbit/attachments so its
    /// path survives (attachments are referenced by file URL).
    private static func saveImage(_ image: NSImage) -> URL? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let dir = SettingsStore.configDirectory().appendingPathComponent("attachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("paste-\(UUID().uuidString).png")
        try? png.write(to: url)
        return url
    }

    // MARK: Reasoning effort

    private func effortButton(_ level: String, for model: ModelConfig,
                              current: String) -> some View {
        Button {
            store.updateModel(id: model.id) { $0.reasoningEffort = level }
        } label: {
            HStack {
                Text(ReasoningLevels.displayName(level))
                if current == level { Image(systemName: "checkmark") }
            }
        }
    }

    /// Add / remove a level from the model's available set (materializing the
    /// default set first so an unchecked default sticks).
    private func toggleLevel(_ level: String, for model: ModelConfig) {
        store.updateModel(id: model.id) { m in
            var set = m.reasoningLevels.isEmpty ? ReasoningLevels.defaults : m.reasoningLevels
            if set.contains(level) { set.removeAll { $0 == level } } else { set.append(level) }
            m.reasoningLevels = ReasoningLevels.sorted(set)
            // If the current pick is no longer offered, fall back to Off.
            if !m.reasoningEffort.isEmpty, !m.reasoningLevels.contains(m.reasoningEffort) {
                m.reasoningEffort = ""
            }
        }
    }

    /// Prompt for a custom effort string (e.g. `max`, `ultra`, `ultracode`).
    private func promptCustomLevel(for model: ModelConfig) {
        let alert = NSAlert()
        alert.messageText = "添加自定义思考档"
        alert.informativeText = "输入该模型接受的 reasoning_effort 值，例如 max、ultra、ultracode。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        field.placeholderString = "如 max"
        alert.accessoryView = field
        alert.addButton(withTitle: "添加")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let level = field.stringValue.trimmingCharacters(in: .whitespaces).lowercased()
        guard !level.isEmpty else { return }
        store.updateModel(id: model.id) { m in
            var set = m.reasoningLevels.isEmpty ? ReasoningLevels.defaults : m.reasoningLevels
            if !set.contains(level) { set.append(level) }
            m.reasoningLevels = ReasoningLevels.sorted(set)
        }
    }

    private func probeReasoning(for model: ModelConfig) {
        guard let resolved = store.settings.resolve(model) else { return }
        probing = true
        Task {
            let result = await ProviderAPI.probeReasoning(resolved)
            probing = false
            switch result {
            case .detected(let levels) where !levels.isEmpty:
                store.updateModel(id: model.id) { $0.reasoningLevels = levels }
                probeMessage = "检测到支持的档位：\(levels.map { ReasoningLevels.displayName($0) }.joined(separator: " / "))"
            case .detected:
                probeMessage = "未检测到受支持的思考档——该模型可能不支持思考，或服务器拒绝了探测请求。"
            case .cannotDetect:
                probeMessage = "该服务器不校验思考档，无法自动探测。已保留默认档，你可在「可选档位」里手动增删或添加自定义。"
            case .failed(let msg):
                probeMessage = "探测失败：\(msg)"
            }
        }
    }

    /// Switch the active agent (persona + tools) for chat, like the model picker.
    private var agentSelector: some View {
        Menu {
            if store.settings.agents.isEmpty {
                Button("添加智能体…") { app.openSettingsWorkspace(.agents) }
            } else {
                ForEach(store.settings.agents) { agent in
                    Button {
                        store.setActiveAgent(id: agent.id)
                    } label: {
                        // Fixed-width icon slot so names line up regardless of the
                        // symbol's intrinsic width; selection shown by a trailing ✓.
                        HStack(spacing: 6) {
                            Image(systemName: agent.icon).frame(width: 18)
                            Text(agent.displayName)
                            if !agent.enabledTools.isEmpty && modelCannotCallTools {
                                Text("（工具不可用）")
                            }
                            if agent.id == store.settings.activeAgentID {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
                Divider()
                Button("管理智能体…") { app.openSettingsWorkspace(.agents) }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: store.settings.activeAgent?.icon ?? "person")
                    .foregroundStyle(Color.accentColor)
                Text(store.settings.activeAgent?.displayName ?? "智能体")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                // The agent uses tools but the current model can't call them.
                if toolsUnavailable {
                    Text("（工具不可用）")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule(style: .continuous))
            .overlay(Capsule(style: .continuous).strokeBorder(Color.secondary.opacity(0.18)))
        }
        .menuStyle(.button)
        .fixedSize()
        .disabled(streamingHere)
        .help(toolsUnavailable
              ? "该智能体启用了工具，但当前模型不支持工具调用"
              : "切换智能体（系统提示词 + 工具）")
    }

    private var modelSelector: some View {
        Menu {
            if chatModels.isEmpty {
                Button("添加渠道商…") { app.openSettingsWorkspace(.providers) }
            } else {
                // Two-level: pick the 渠道商 first, then a model in its submenu —
                // a flat list of every model across channels doesn't scale.
                ForEach(chatProviders) { provider in
                    Menu(provider.name) {
                        ForEach(chatModels(in: provider)) { model in
                            Button {
                                store.settings.llmModelID = model.id
                            } label: {
                                Label(
                                    model.name.isEmpty ? model.model : model.name,
                                    systemImage: model.id == store.settings.llmModelID
                                        ? "checkmark.circle.fill" : "circle"
                                )
                            }
                        }
                    }
                }
                Divider()
                Button("管理渠道商…") { app.openSettingsWorkspace(.providers) }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "brain.head.profile")
                    .foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text(selectedLLM?.name ?? "选择大模型")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(selectedLLM.map { store.settings.displayLabel(for: $0) } ?? "LLM")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule(style: .continuous))
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.secondary.opacity(0.18))
            )
        }
        .menuStyle(.button)
        .fixedSize()
        .disabled(streamingHere)
        .help(selectedLLM?.llmCapabilities.summary ?? "选择聊天使用的大语言模型")
    }

    private func send() {
        let text = draft
        let images = attachments
        draft = ""
        attachments = []
        chat.send(text, images: images)
    }

    /// Horizontal strip of pending image attachments, each removable.
    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments, id: \.self) { url in
                    ZStack(alignment: .topTrailing) {
                        if let img = NSImage(contentsOf: url) {
                            Image(nsImage: img)
                                .resizable().aspectRatio(contentMode: .fill)
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        Button { attachments.removeAll { $0 == url } } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 14))
                                .foregroundStyle(.white, .black.opacity(0.55))
                        }
                        .buttonStyle(.plain).padding(2)
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func ensureValidLLMSelection() {
        if let id = store.settings.llmModelID,
           chatModels.contains(where: { $0.id == id }) {
            return
        }
        store.settings.llmModelID = chatModels.first?.id
    }
}

// MARK: - Message row

private struct MessageRow: View {
    let message: ChatMessage
    var streaming: Bool = false
    var startedAt: Date? = nil
    var liveTokens: Int = 0

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 60)
                VStack(alignment: .trailing, spacing: 6) {
                    ForEach(message.attachments ?? [], id: \.self) { path in
                        if let img = NSImage(contentsOfFile: path) {
                            Image(nsImage: img)
                                .resizable().aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 260, maxHeight: 260)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    // Verbatim — don't reinterpret the user's text as Markdown.
                    if !message.content.isEmpty {
                        Text(message.content)
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Color.accentColor.opacity(0.18)))
                    }
                }
            }
        } else {
            // Assistant replies run full-width; the brand mark now lives in the
            // footer below the message (a breathing status while streaming, a
            // quiet "· 8s · 2.4k tokens" once done) — not as a left-side avatar.
            VStack(alignment: .leading, spacing: 6) {
                if !message.content.isEmpty {
                    ChatMarkdown(content: message.content)
                        .modifier(StreamFade(active: streaming))
                }
                ForEach(message.toolCalls ?? [], id: \.id) { call in
                    Label("调用技能 \(call.name)", systemImage: "wand.and.stars")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }
                // The per-message status footer moved to a single indicator in the
                // composer (see GenerationStatus) — no logo/token line under every reply.
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The status line beneath an assistant reply — Orbit's iridescent mark plus a
/// live-ticking elapsed timer while streaming, settling to a quiet
/// "8s · 2.4k tokens" once the reply lands. Older messages without recorded
/// stats simply show nothing.
private struct AssistantFooter: View {
    let message: ChatMessage
    let streaming: Bool
    let startedAt: Date?
    var liveTokens: Int = 0

    var body: some View {
        if streaming {
            HStack(spacing: 7) {
                OrbitMark(size: 16, active: true)
                TimelineView(.periodic(from: .now, by: 0.25)) { ctx in
                    Text(statusText(now: ctx.date))
                        .font(.caption).monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                if liveTokens > 0 {
                    // The live counter — rolls digits as deltas stream in.
                    Text("\(AssistantFooter.formatTokens(liveTokens)) tokens")
                        .font(.caption.weight(.semibold)).monospacedDigit()
                        .foregroundStyle(Color.accentColor)
                        .contentTransition(.numericText(value: Double(liveTokens)))
                        .animation(.snappy(duration: 0.25), value: liveTokens)
                }
            }
            .padding(.top, 2)
        } else if message.elapsed != nil || message.tokens != nil {
            HStack(spacing: 6) {
                OrbitMark(size: 13, active: false)
                Text(doneLabel)
                    .font(.caption2).monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            .padding(.top, 2)
        }
    }

    private func statusText(now: Date) -> String {
        let secs = max(0, now.timeIntervalSince(startedAt ?? now))
        let time = AssistantFooter.formatTime(secs)
        return message.content.isEmpty ? "思考中 · \(time)" : "生成中 · \(time) ·"
    }

    private var doneLabel: String {
        var parts: [String] = []
        if let e = message.elapsed { parts.append(AssistantFooter.formatTime(e)) }
        if let t = message.tokens, t > 0 { parts.append("\(AssistantFooter.formatTokens(t)) tokens") }
        return parts.joined(separator: " · ")
    }

    static func formatTime(_ s: TimeInterval) -> String {
        let total = Int(s.rounded())
        return total < 60 ? "\(total)s" : "\(total / 60)m \(total % 60)s"
    }

    /// <1000 → raw count; <1M → K; ≥1M → M (one decimal until 3 digits).
    static func formatTokens(_ n: Int) -> String {
        switch n {
        case ..<1000:
            return "\(n)"
        case ..<1_000_000:
            let k = Double(n) / 1000
            return String(format: k < 100 ? "%.1fK" : "%.0fK", k)
        default:
            let m = Double(n) / 1_000_000
            return String(format: m < 100 ? "%.1fM" : "%.0fM", m)
        }
    }
}

/// Streaming reveal: while a reply streams, mask the reply so its trailing edge
/// (where the newest tokens land) fades from full colour up top to near-transparent
/// at the bottom — new text emerges softly (透明→有色) instead of snapping in. The
/// mask height is a fixed band so short and long replies fade the same amount; it
/// lifts to fully opaque the instant streaming ends.
private struct StreamFade: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content
            .mask(alignment: .top) {
                GeometryReader { geo in
                    if active && geo.size.height > 8 {
                        let fade = min(34, geo.size.height * 0.5)   // fade band height
                        VStack(spacing: 0) {
                            Rectangle().fill(.black)
                            LinearGradient(colors: [.black, .black.opacity(0.06)],
                                           startPoint: .top, endPoint: .bottom)
                                .frame(height: fade)
                        }
                    } else {
                        Rectangle().fill(.black)
                    }
                }
            }
            .animation(.easeOut(duration: 0.35), value: active)
    }
}

/// Forces the transcript's underlying `NSScrollView` to the thin OVERLAY scroller
/// (narrow knob, NO track) regardless of the system "Show scroll bars" setting,
/// which otherwise draws the wide legacy scroller-with-track. Added as a zero-size
/// background of the scroll content so it can reach the scroll view via
/// `enclosingScrollView`.
private struct ScrollerStyler: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView(frame: .zero)
        DispatchQueue.main.async { style(from: v) }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { style(from: nsView) }
    }
    private func style(from v: NSView) {
        guard let sv = v.enclosingScrollView else { return }
        sv.scrollerStyle = .overlay          // thin, no track, auto-hiding
        sv.autohidesScrollers = true
        sv.verticalScroller?.controlSize = .small   // narrower knob
        sv.horizontalScrollElasticity = .none
        sv.drawsBackground = false
    }
}

/// The single generation status in the composer (replaces the old per-message
/// footer). Resting state = just Orbit's satellite mark ("原来卫星的状态"); while a
/// reply streams it animates and shows the elapsed timer + the live token count of
/// THIS run only — both disappear the moment it finishes.
private struct GenerationStatus: View {
    let streaming: Bool
    let startedAt: Date?
    let liveTokens: Int

    var body: some View {
        HStack(spacing: 8) {
            OrbitMark(size: 26, active: streaming)
            if streaming {
                TimelineView(.periodic(from: .now, by: 0.25)) { ctx in
                    Text(statusText(now: ctx.date))
                        .font(.caption).monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                if liveTokens > 0 {
                    Text("\(AssistantFooter.formatTokens(liveTokens)) tokens")
                        .font(.caption.weight(.semibold)).monospacedDigit()
                        .foregroundStyle(Color.accentColor)
                        .contentTransition(.numericText(value: Double(liveTokens)))
                        .animation(.snappy(duration: 0.25), value: liveTokens)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
        .animation(.easeOut(duration: 0.25), value: streaming)
        .help(streaming ? "生成中" : "Orbit")
    }

    private func statusText(now: Date) -> String {
        let secs = max(0, now.timeIntervalSince(startedAt ?? now))
        let word = liveTokens > 0 ? "生成中" : "思考中"
        return "\(word) · \(AssistantFooter.formatTime(secs))"
    }
}

/// Circular context gauge in the composer: how much of the model's context
/// window the current conversation occupies. Fills clockwise, warms from
/// accent → orange → red as it approaches the limit; hover for exact figures.
private struct ContextRing: View {
    let used: Int
    let limit: Int

    @State private var hovering = false
    @State private var showDetail = false

    /// Ring/% lit up either while hovering OR while the detail bubble is open.
    private var active: Bool { hovering || showDetail }

    private var fraction: Double {
        guard limit > 0 else { return 0 }
        return min(1, Double(used) / Double(limit))
    }

    private var ringColor: Color {
        switch fraction {
        case ..<0.7: return .accentColor
        case ..<0.9: return .orange
        default: return .red
        }
    }

    var body: some View {
        Button { showDetail.toggle() } label: {
            HStack(spacing: 6) {
                ZStack {
                    Circle()
                        .stroke(Color.secondary.opacity(active ? 0.35 : 0.22), lineWidth: 2.5)
                    Circle()
                        .trim(from: 0, to: max(fraction, 0.02))
                        .stroke(ringColor.opacity(active ? 1 : 0.9),
                                style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .shadow(color: active ? ringColor.opacity(0.5) : .clear, radius: 3)
                        .animation(.easeOut(duration: 0.3), value: fraction)
                }
                .frame(width: 18, height: 18)
                // The % is hidden by default; it slides in only on hover (or while
                // the detail bubble is open) — condensed info, nothing more.
                if active {
                    Text("\(Int((fraction * 100).rounded()))%")
                        .font(.caption2).monospacedDigit()
                        .foregroundStyle(ringColor)
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                }
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.18), value: active)
        .popover(isPresented: $showDetail, arrowEdge: .top) { detailBubble }
        .help("上下文占用 · 点击查看详情")
    }

    /// A compact chat-bubble-style popover (arrow points back at the ring), not a
    /// big dialog — a header line + the used/window breakdown.
    private var detailBubble: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Circle().fill(ringColor).frame(width: 8, height: 8)
                Text("上下文占用").font(.caption.weight(.semibold))
                Spacer(minLength: 10)
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.caption.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(ringColor)
            }
            Divider()
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                GridRow {
                    Text("已使用").foregroundStyle(.secondary)
                    Text("~\(AssistantFooter.formatTokens(used)) tokens").monospacedDigit()
                }
                GridRow {
                    Text("窗口长度").foregroundStyle(.secondary)
                    Text("\(AssistantFooter.formatTokens(limit)) tokens").monospacedDigit()
                }
            }
            .font(.caption)
            Text("估算值，以服务商回报为准")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(minWidth: 190)
    }

    /// Best-effort context-window lookup from the raw model id. Falls back to
    /// 128K when unknown — most current chat models offer at least that.
    static func contextWindow(for modelID: String) -> Int {
        let id = modelID.lowercased()
        if id.contains("gemini-1.5-pro") { return 2_097_152 }
        if id.contains("gemini") { return 1_048_576 }
        if id.contains("gpt-4.1") { return 1_047_576 }
        if id.contains("claude") { return 200_000 }
        if id.contains("o1") || id.contains("o3") || id.contains("o4") { return 200_000 }
        if id.contains("kimi") || id.contains("moonshot") { return 256_000 }
        if id.contains("qwen") { return 131_072 }
        if id.contains("glm") { return 128_000 }
        if id.contains("deepseek") { return 128_000 }
        if id.contains("gpt-4o") || id.contains("gpt-5") { return 128_000 }
        return 128_000
    }
}

/// A tool's outcome in the transcript: a status chip plus any produced assets
/// (generated images render inline; double-click opens the file).
private struct ToolResultRow: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: message.toolResult?.isError == true
                  ? "exclamationmark.triangle" : "checkmark.seal")
                .font(.system(size: 13))
                .foregroundStyle(message.toolResult?.isError == true ? Color.orange : Color.green)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 8) {
                if message.toolResult?.isError == true {
                    Text(message.toolResult?.content ?? "")
                        .font(.caption).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    Text("技能执行完成")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(message.attachments ?? [], id: \.self) { path in
                    if ["mp4", "mov", "webm", "m4v"].contains(URL(fileURLWithPath: path).pathExtension.lowercased()) {
                        VideoPlayer(player: AVPlayer(url: URL(fileURLWithPath: path)))
                            .frame(width: 360, height: 220)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    } else if let img = NSImage(contentsOfFile: path) {
                        Image(nsImage: img)
                            .resizable().aspectRatio(contentMode: .fit)
                            .frame(maxWidth: 360, maxHeight: 360)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .onTapGesture(count: 2) {
                                NSWorkspace.shared.open(URL(fileURLWithPath: path))
                            }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

