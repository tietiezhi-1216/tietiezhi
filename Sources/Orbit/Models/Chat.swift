//  Chat.swift
//  The conversation model behind Orbit's chat (Agent) surface. Codable so a
//  later debounced JSON writer can persist conversations, but in-memory for now.

import Foundation

enum ChatRole: String, Codable, Hashable {
    case system, user, assistant
}

struct ChatMessage: Identifiable, Codable, Hashable {
    let id: UUID
    let role: ChatRole
    var content: String

    init(id: UUID = UUID(), role: ChatRole, content: String) {
        self.id = id
        self.role = role
        self.content = content
    }
}

struct Conversation: Identifiable, Codable, Hashable {
    let id: UUID
    var title: String
    var messages: [ChatMessage]
    var createdAt: Date

    init(id: UUID = UUID(),
         title: String = "新对话",
         messages: [ChatMessage] = [],
         createdAt: Date = Date()) {
        self.id = id
        self.title = title
        self.messages = messages
        self.createdAt = createdAt
    }

    /// A short title derived from the first user message.
    static func deriveTitle(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "新对话" }
        let firstLine = trimmed.split(whereSeparator: \.isNewline).first.map(String.init) ?? trimmed
        return firstLine.count > 30 ? String(firstLine.prefix(30)) + "…" : firstLine
    }
}
