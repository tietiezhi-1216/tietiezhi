//  Chat.swift
//  The conversation model behind Orbit's chat (Agent) surface. Codable so a
//  later debounced JSON writer can persist conversations, but in-memory for now.

import Foundation

enum ChatRole: String, Codable, Hashable {
    case system, user, assistant, tool
}

/// Reasoning / "thinking" effort is just the string a model accepts for
/// `reasoning_effort` (OpenAI Chat) / `reasoning.effort` (Responses) — an empty
/// string means off. Vendors use different sets (`minimal/low/medium/high`,
/// plus non-standard extras like `xhigh`, `max`, `ultra`, `ultracode`), and the
/// set is per-model, so levels are free-form strings, discovered by probing or
/// added by hand. `ReasoningLevels` centralizes the naming / ordering / budget.
enum ReasoningLevels {
    /// The empty string used to mean "no reasoning".
    static let off = ""

    /// The candidate strings a probe tries when discovering a model's levels —
    /// the OpenAI standard set plus the common non-standard highs.
    static let candidates = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]

    /// Levels shown until a model is probed or hand-configured.
    static let defaults = ["low", "medium", "high"]

    /// Canonical display order; unknowns sort last, alphabetically.
    private static let order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]

    static func sorted(_ levels: [String]) -> [String] {
        levels.sorted { a, b in
            let ia = order.firstIndex(of: a.lowercased()) ?? Int.max
            let ib = order.firstIndex(of: b.lowercased()) ?? Int.max
            return ia == ib ? a < b : ia < ib
        }
    }

    static func displayName(_ level: String) -> String {
        let l = level.lowercased()
        if l.isEmpty { return "Off" }
        if l == "xhigh" { return "Extra High" }
        return level.prefix(1).uppercased() + level.dropFirst()
    }

    /// Anthropic `thinking.budget_tokens` for a named level (best-effort mapping).
    static func anthropicBudget(_ level: String) -> Int {
        switch level.lowercased() {
        case "minimal": return 1_024
        case "low":     return 2_048
        case "medium":  return 4_096
        case "high":    return 8_192
        default:        return 16_384   // xhigh / max / ultra / custom highs
        }
    }
}

/// A tool invocation the assistant asked for. `argumentsJSON` is kept as the raw
/// JSON string the model produced (OpenAI streams it in fragments; Anthropic
/// gives an object we re-serialize) so it round-trips verbatim in follow-ups.
struct ToolCall: Codable, Hashable {
    var id: String
    var name: String
    var argumentsJSON: String
}

/// The outcome of running a tool, fed back to the model on the next round.
struct ToolResult: Codable, Hashable {
    var toolCallID: String
    var content: String
    var isError: Bool
}

struct ChatMessage: Identifiable, Codable, Hashable {
    let id: UUID
    let role: ChatRole
    var content: String
    /// Set on an assistant message that requested tool invocations.
    var toolCalls: [ToolCall]?
    /// Set on a `.tool` message carrying a tool's output back to the model.
    var toolResult: ToolResult?
    /// Local file paths of assets a tool produced (images/videos) so the
    /// transcript can render them inline.
    var attachments: [String]?
    /// Wall-clock seconds the assistant turn took, frozen when the stream ends —
    /// drives the "· 8s" in the transcript footer. Nil for non-streamed messages.
    var elapsed: TimeInterval?
    /// Output tokens the provider reported for the turn (nil if not reported) —
    /// drives the "· 2.4k tokens" in the footer.
    var tokens: Int?

    init(id: UUID = UUID(), role: ChatRole, content: String,
         toolCalls: [ToolCall]? = nil, toolResult: ToolResult? = nil,
         attachments: [String]? = nil,
         elapsed: TimeInterval? = nil, tokens: Int? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.toolCalls = toolCalls
        self.toolResult = toolResult
        self.attachments = attachments
        self.elapsed = elapsed
        self.tokens = tokens
    }
}

struct Conversation: Identifiable, Codable, Hashable {
    let id: UUID
    var title: String
    var messages: [ChatMessage]
    var createdAt: Date
    /// True once the user renamed it by hand — the AI title generator won't overwrite.
    var titleLocked: Bool = false

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
