//  ChatDetailView.swift
//  The chat transcript + composer. Streams assistant replies from the active
//  LLM; shows helpful empty states when there's no conversation or no model.

import SwiftUI
import AppKit
import AVKit

struct ChatDetailView: View {
    @EnvironmentObject var chat: ChatStore
    @EnvironmentObject private var store: SettingsStore
    @EnvironmentObject private var app: AppController

    let openSettings: () -> Void

    @State private var draft = ""

    /// True only when a stream is active for the *currently shown* conversation.
    private var streamingHere: Bool {
        guard let id = chat.selectedID else { return false }
        return chat.isStreaming(id)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !streamingHere && chat.hasLLM
    }

    private var chatModels: [ModelConfig] {
        store.settings.chatModels
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
                            } else if message.role == .assistant && message.content.isEmpty
                                        && (message.toolCalls ?? []).isEmpty {
                                ThinkingRow()
                            } else {
                                MessageRow(message: message)
                            }
                        }
                        .id(message.id)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 20)
            }
            .onChange(of: convo.messages.last?.content) { _, _ in
                scrollToBottom(proxy, convo)
            }
            .onChange(of: convo.messages.count) { _, _ in
                scrollToBottom(proxy, convo)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, _ convo: Conversation) {
        guard let last = convo.messages.last?.id else { return }
        withAnimation(.easeOut(duration: 0.12)) {
            proxy.scrollTo(last, anchor: .bottom)
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
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    modelSelector
                    if let selectedLLM {
                        LLMCapabilityBadges(capabilities: selectedLLM.llmCapabilities, compact: true)
                    }
                    Spacer(minLength: 0)
                }

                HStack(alignment: .bottom, spacing: 10) {
                    TextField(chat.hasLLM ? "给 Orbit 发消息…" : "先选择一个大模型…", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...6)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 10)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.secondary.opacity(0.20)))

                    if streamingHere {
                        Button { chat.cancel() } label: {
                            Image(systemName: "stop.fill")
                                .foregroundStyle(.primary)
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(Color.secondary.opacity(0.22)))
                        }
                        .buttonStyle(.plain)
                        .help("停止")
                    } else {
                        Button { send() } label: {
                            Image(systemName: "arrow.up")
                                .fontWeight(.bold)
                                .foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.4)))
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                        .keyboardShortcut(.return, modifiers: .command)
                        .help(chat.hasLLM ? "发送（⌘↩）" : "先选择大模型")
                    }
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 14)
        }
        .background(.bar)
    }

    private var modelSelector: some View {
        Menu {
            if chatModels.isEmpty {
                Button("添加渠道商…") { app.openSettingsWorkspace(.providers) }
            } else {
                ForEach(chatModels) { model in
                    Button {
                        store.settings.llmModelID = model.id
                    } label: {
                        // 渠道商/模型ID keeps same-named models across channels distinct.
                        Label(
                            store.settings.displayLabel(for: model),
                            systemImage: model.id == store.settings.llmModelID ? "checkmark.circle.fill" : "circle"
                        )
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
        draft = ""
        chat.send(text)
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

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 60)
                // Verbatim — don't reinterpret the user's text as Markdown.
                Text(message.content)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.accentColor.opacity(0.18)))
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "sparkle")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.accentColor)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 6) {
                    if !message.content.isEmpty {
                        // Assistant replies render basic Markdown.
                        Text(.init(message.content))
                            .textSelection(.enabled)
                    }
                    ForEach(message.toolCalls ?? [], id: \.id) { call in
                        Label("调用技能 \(call.name)", systemImage: "wand.and.stars")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
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

/// The assistant "thinking" placeholder shown before the first token arrives.
private struct ThinkingRow: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "sparkle")
                .font(.system(size: 13))
                .foregroundStyle(Color.accentColor)
                .padding(.top, 2)
            ProgressView().controlSize(.small)
            Spacer(minLength: 0)
        }
    }
}
