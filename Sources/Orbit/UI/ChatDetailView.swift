//  ChatDetailView.swift
//  The chat transcript + composer. Streams assistant replies from the active
//  LLM; shows helpful empty states when there's no conversation or no model.

import SwiftUI
import AppKit

struct ChatDetailView: View {
    @EnvironmentObject var chat: ChatStore
    let openSettings: () -> Void

    @State private var draft = ""

    /// True only when a stream is active for the *currently shown* conversation.
    private var streamingHere: Bool {
        guard let id = chat.selectedID else { return false }
        return chat.isStreaming(id)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !streamingHere
    }

    var body: some View {
        VStack(spacing: 0) {
            if let convo = chat.selected, !convo.messages.isEmpty {
                transcript(convo)
            } else {
                emptyState
            }
            Divider()
            composer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Transcript

    private func transcript(_ convo: Conversation) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(convo.messages) { message in
                        Group {
                            if message.role == .assistant && message.content.isEmpty {
                                ThinkingRow()
                            } else {
                                MessageRow(message: message)
                            }
                        }
                        .id(message.id)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 40)
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
        VStack(spacing: 14) {
            Spacer()
            if !chat.hasLLM {
                Image(systemName: "sparkles").font(.system(size: 38)).foregroundStyle(.secondary)
                Text("尚未配置大模型").font(.title3.weight(.medium))
                Text("点左下角「设置 → 模型」添加一个大模型并选为当前大模型。")
                    .font(.callout).foregroundStyle(.secondary)
                Button("打开设置") { openSettings() }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            } else {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 38)).foregroundStyle(.secondary)
                Text("今天想聊点什么？")
                    .font(.title3.weight(.medium)).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Composer

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("给 Orbit 发消息…", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(Color.secondary.opacity(0.25)))

            if streamingHere {
                Button { chat.cancel() } label: {
                    Image(systemName: "stop.fill")
                        .foregroundStyle(.primary)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Color.secondary.opacity(0.22)))
                }
                .buttonStyle(.plain)
                .help("停止")
            } else {
                Button { send() } label: {
                    Image(systemName: "arrow.up")
                        .fontWeight(.bold)
                        .foregroundStyle(.white)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(canSend ? Color.accentColor : Color.secondary.opacity(0.4)))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
                .help("发送（⌘↩）")
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private func send() {
        let text = draft
        draft = ""
        chat.send(text)
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
                // Assistant replies render basic Markdown.
                Text(.init(message.content))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
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
