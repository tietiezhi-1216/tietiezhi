//  ChatStore.swift
//  In-memory conversation state for the chat (Agent) surface, plus streaming
//  send/cancel. Resolves the active LLM from the shared SettingsStore — the same
//  model dictation's polish uses, so there's no separate chat config.
//  (Persistence to ~/Library/Application Support/com.orbit.app/conversations.json
//  is a straightforward follow-up: the models are already Codable.)

import Foundation
import Combine

@MainActor
final class ChatStore: ObservableObject {
    @Published var conversations: [Conversation] = []
    @Published var selectedID: UUID?
    @Published var isStreaming = false

    private let settings: SettingsStore
    private let usage: UsageStore
    private var streamTask: Task<Void, Never>?

    init(settings: SettingsStore, usage: UsageStore) {
        self.settings = settings
        self.usage = usage
    }

    var selected: Conversation? {
        guard let id = selectedID else { return nil }
        return conversations.first { $0.id == id }
    }

    /// True once an LLM model is configured + selected as the active one.
    var hasLLM: Bool {
        settings.settings.llmModel.flatMap { settings.settings.resolve($0) } != nil
    }

    /// Whether a stream is active *for this specific conversation* (so the
    /// composer/spinner of other conversations aren't wrongly locked).
    func isStreaming(_ conversationID: UUID) -> Bool {
        isStreaming && streamingConversationID == conversationID
    }

    // MARK: - Conversation list

    func newConversation() {
        cancel()
        selectedID = nil
    }

    func deleteConversation(id: UUID) {
        if streamingConversationID == id { cancel() }
        conversations.removeAll { $0.id == id }
        if selectedID == id {
            selectedID = conversations.first?.id
        }
    }

    func renameConversation(id: UUID, title: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        conversations[i].title = trimmed.isEmpty ? "新对话" : trimmed
    }

    // MARK: - Streaming

    @Published private(set) var streamingConversationID: UUID?
    private var streamingMessageID: UUID?

    func cancel() {
        streamTask?.cancel()
        streamTask = nil
        // Drop an assistant placeholder that never received any content.
        if let cid = streamingConversationID, let mid = streamingMessageID,
           let ci = conversations.firstIndex(where: { $0.id == cid }),
           let mi = conversations[ci].messages.firstIndex(where: { $0.id == mid }),
           conversations[ci].messages[mi].role == .assistant,
           conversations[ci].messages[mi].content.isEmpty {
            conversations[ci].messages.remove(at: mi)
        }
        streamingConversationID = nil
        streamingMessageID = nil
        isStreaming = false
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }
        let ci: Int
        let cid: UUID

        if let selectedID, let existingIndex = conversations.firstIndex(where: { $0.id == selectedID }) {
            ci = existingIndex
            cid = selectedID
        } else {
            let convo = Conversation()
            conversations.insert(convo, at: 0)
            selectedID = convo.id
            ci = 0
            cid = convo.id
        }

        conversations[ci].messages.append(ChatMessage(role: .user, content: trimmed))
        if conversations[ci].title == "新对话" {
            conversations[ci].title = Conversation.deriveTitle(from: trimmed)
        }

        // No model configured → answer locally instead of hitting the network.
        guard let model = settings.settings.llmModel.flatMap({ settings.settings.resolve($0) }) else {
            conversations[ci].messages.append(
                ChatMessage(role: .assistant,
                            content: "请先在「设置 → 模型」里配置一个大模型，并选为当前大模型。")
            )
            return
        }

        let assistant = ChatMessage(role: .assistant, content: "")
        let aid = assistant.id
        // Build the request history BEFORE adding the placeholder, dropping any
        // empty assistant turns (e.g. a prior interrupted reply) some strict
        // servers reject.
        let history = conversations[ci].messages.filter {
            !($0.role == .assistant && $0.content.trimmed.isEmpty)
        }
        conversations[ci].messages.append(assistant)

        isStreaming = true
        streamingConversationID = cid
        streamingMessageID = aid
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let tokens = try await ChatClient.stream(model: model, messages: history) { piece in
                    self.appendDelta(piece, conversationID: cid, messageID: aid)
                }
                // Record token usage + cost for the chat turn.
                if let cfg = self.settings.settings.llmModel, !tokens.isEmpty {
                    self.usage.add(self.settings.settings.usageRecord(
                        for: cfg, source: "chat", date: Date(), usage: tokens))
                }
                // Completed with no content at all → leave a visible note rather
                // than a permanently empty bubble.
                self.noteIfEmpty(conversationID: cid, messageID: aid)
            } catch {
                if !Task.isCancelled && !(error is CancellationError) {
                    self.appendDelta("\n\n[出错] \(error.localizedDescription)",
                                     conversationID: cid, messageID: aid)
                }
            }
            self.isStreaming = false
            self.streamingConversationID = nil
            self.streamingMessageID = nil
            self.streamTask = nil
        }
    }

    private func appendDelta(_ piece: String, conversationID: UUID, messageID: UUID) {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }),
              let mi = conversations[ci].messages.firstIndex(where: { $0.id == messageID }) else { return }
        conversations[ci].messages[mi].content += piece
    }

    private func noteIfEmpty(conversationID: UUID, messageID: UUID) {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }),
              let mi = conversations[ci].messages.firstIndex(where: { $0.id == messageID }),
              conversations[ci].messages[mi].content.isEmpty else { return }
        conversations[ci].messages[mi].content = "（模型没有返回内容）"
    }
}
