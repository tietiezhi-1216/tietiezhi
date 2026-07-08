//  ChatStore.swift
//  Conversation state for the chat (Agent) surface, plus streaming send/cancel.
//  Resolves the active LLM from the shared SettingsStore — the same model
//  dictation's polish uses, so there's no separate chat config. Conversations are
//  persisted as JSON under Application Support (debounced writes, flushed on
//  quit), so history survives restarts.

import Foundation
import Combine

@MainActor
final class ChatStore: ObservableObject {
    @Published var conversations: [Conversation]
    @Published var selectedID: UUID?
    @Published var isStreaming = false

    private let settings: SettingsStore
    private let usage: UsageStore
    private let tools: ToolRegistry
    private let skills: SkillStore
    private var streamTask: Task<Void, Never>?

    /// SQLite persistence — one row per conversation (metadata columns + a JSON
    /// blob of the full conversation), so a change rewrites only that row instead
    /// of the whole history. `dirty` collects ids to flush; writes are debounced.
    private let db: SQLiteDB
    private var dirty: Set<UUID> = []
    private var saveTask: Task<Void, Never>?

    /// Safety cap on model→tool→model rounds within one send.
    private let maxToolRounds = 5

    init(settings: SettingsStore, usage: UsageStore, tools: ToolRegistry, skills: SkillStore, db: SQLiteDB) {
        self.settings = settings
        self.usage = usage
        self.tools = tools
        self.skills = skills
        self.db = db
        db.exec("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY, title TEXT, createdAt REAL, updatedAt REAL, data BLOB
            );
            """)
        ChatStore.migrateFromJSONIfNeeded(db)
        conversations = ChatStore.loadAll(db)
        selectedID = conversations.first?.id
    }

    // MARK: - Persistence (SQLite)

    private static func loadAll(_ db: SQLiteDB) -> [Conversation] {
        var out: [Conversation] = []
        db.query("SELECT data FROM conversations ORDER BY updatedAt DESC;") { row in
            if let c = try? JSONDecoder().decode(Conversation.self, from: row.blob(0)) { out.append(c) }
        }
        // Drop any assistant/tool placeholder left dangling by a quit mid-stream.
        for i in out.indices {
            while let last = out[i].messages.last,
                  (last.role == .assistant || last.role == .tool),
                  last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  (last.toolCalls ?? []).isEmpty {
                out[i].messages.removeLast()
            }
        }
        return out
    }

    /// One-time import of the previous conversations.json into the fresh table.
    private static func migrateFromJSONIfNeeded(_ db: SQLiteDB) {
        guard db.scalarInt("SELECT COUNT(*) FROM conversations;") == 0 else { return }
        let url = SettingsStore.configDirectory().appendingPathComponent("conversations.json")
        guard let data = try? Data(contentsOf: url),
              let convos = try? JSONDecoder().decode([Conversation].self, from: data) else { return }
        db.transaction { for c in convos { upsert(c, db) } }
        try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("migrated"))
    }

    private static func upsert(_ c: Conversation, _ db: SQLiteDB) {
        guard let data = try? JSONEncoder().encode(c) else { return }
        db.run("""
            INSERT INTO conversations (id, title, createdAt, updatedAt, data) VALUES (?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title, updatedAt=excluded.updatedAt, data=excluded.data;
            """,
            [.text(c.id.uuidString), .text(c.title),
             .double(c.createdAt.timeIntervalSince1970), .double(Date().timeIntervalSince1970),
             .blob(data)])
    }

    /// Mark a conversation changed and schedule a debounced flush.
    private func touch(_ id: UUID) {
        dirty.insert(id)
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            self?.flushDirty()
        }
    }

    private func flushDirty() {
        guard !dirty.isEmpty else { return }
        let ids = dirty; dirty.removeAll()
        db.transaction {
            for id in ids where conversations.contains(where: { $0.id == id }) {
                if let c = conversations.first(where: { $0.id == id }) { ChatStore.upsert(c, db) }
            }
        }
    }

    /// Force an immediate write (e.g. on app termination).
    func flush() {
        saveTask?.cancel()
        flushDirty()
    }

    private func deleteRow(_ id: UUID) {
        dirty.remove(id)
        db.run("DELETE FROM conversations WHERE id = ?;", [.text(id.uuidString)])
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

    /// Whether this specific message is the one currently being streamed (drives
    /// the avatar's orbiting animation).
    func isStreamingMessage(_ id: UUID) -> Bool {
        isStreaming && streamingMessageID == id
    }

    // MARK: - Conversation list

    func newConversation() {
        cancel()
        selectedID = nil
    }

    func deleteConversation(id: UUID) {
        if streamingConversationID == id { cancel() }
        conversations.removeAll { $0.id == id }
        deleteRow(id)
        if selectedID == id {
            selectedID = conversations.first?.id
        }
    }

    func renameConversation(id: UUID, title: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        conversations[i].title = trimmed.isEmpty ? "新对话" : trimmed
        conversations[i].titleLocked = true
        touch(id)
    }

    /// Generate a short topic title from the first user message (like ChatGPT).
    /// Runs as a side call; won't overwrite a title the user renamed by hand.
    private func generateTitle(conversationID: UUID, seed: String) {
        guard let model = settings.settings.llmModel.flatMap({ settings.settings.resolve($0) }) else { return }
        let messages = [
            ChatMessage(role: .system, content: "根据用户的第一条消息，生成一个不超过 12 个字、概括对话主题的简短标题。只返回标题本身：不要引号、不要句末标点、不要「标题：」之类前缀、不要解释。"),
            ChatMessage(role: .user, content: String(seed.prefix(500))),
        ]
        Task { [weak self] in
            var title = ""
            do {
                _ = try await ChatClient.stream(model: model, messages: messages) { piece in
                    title += piece
                }
            } catch { return }
            guard let self else { return }
            let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'“”「」 "))
            guard !clean.isEmpty,
                  let i = self.conversations.firstIndex(where: { $0.id == conversationID }),
                  !self.conversations[i].titleLocked else { return }
            self.conversations[i].title = String(clean.prefix(24))
            self.touch(conversationID)
        }
    }

    // MARK: - Streaming

    @Published private(set) var streamingConversationID: UUID?
    /// When the active turn started — drives the live-ticking elapsed timer in the
    /// transcript footer. Nil whenever nothing is streaming.
    @Published private(set) var streamStartedAt: Date?
    private var streamingMessageID: UUID?

    /// Live output-token count for the active turn. Ticks up from a character
    /// heuristic as deltas stream in, then snaps to the provider-reported
    /// figure whenever a round's usage lands — so the footer counts in real
    /// time without waiting for the trailing usage chunk.
    @Published private(set) var liveOutputTokens: Int = 0
    private var liveTokenAccum: Double = 0

    /// Last known context occupancy per conversation (prompt + reply tokens of
    /// the most recent turn, provider-reported). Drives the composer's ring.
    @Published private(set) var contextUsed: [UUID: Int] = [:]

    /// Rough token estimate for arbitrary text: CJK ≈ 1 token/char, everything
    /// else ≈ 4 chars/token. Only used for live display; real usage overrides.
    static func estimateTokens(_ text: String) -> Double {
        var cjk = 0, other = 0
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x2E80...0x9FFF, 0x3000...0x303F, 0xF900...0xFAFF, 0xFF00...0xFFEF:
                cjk += 1
            default:
                other += 1
            }
        }
        return Double(cjk) + Double(other) / 4.0
    }

    /// Context occupancy to display for a conversation: the provider-reported
    /// figure when we have one, otherwise a character estimate of the whole
    /// transcript; the in-flight turn's live tokens ride on top.
    func contextTokens(for conversationID: UUID) -> Int {
        var base = contextUsed[conversationID] ?? conversations
            .first { $0.id == conversationID }
            .map { convo in Int(convo.messages.reduce(0) { $0 + Self.estimateTokens($1.content) }) } ?? 0
        if streamingConversationID == conversationID { base += liveOutputTokens }
        return base
    }

    func cancel() {
        streamTask?.cancel()
        streamTask = nil
        let cid = streamingConversationID
        // Drop an assistant placeholder that never received any content.
        if let cid, let mid = streamingMessageID,
           let ci = conversations.firstIndex(where: { $0.id == cid }),
           let mi = conversations[ci].messages.firstIndex(where: { $0.id == mid }),
           conversations[ci].messages[mi].role == .assistant,
           conversations[ci].messages[mi].content.isEmpty {
            conversations[ci].messages.remove(at: mi)
        }
        streamingConversationID = nil
        streamingMessageID = nil
        streamStartedAt = nil
        isStreaming = false
        if let cid { touch(cid) }   // persist the post-cancel state
    }

    func send(_ text: String, images: [URL] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!trimmed.isEmpty || !images.isEmpty), !isStreaming else { return }
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

        let imagePaths = images.map(\.path)
        conversations[ci].messages.append(
            ChatMessage(role: .user, content: trimmed,
                        attachments: imagePaths.isEmpty ? nil : imagePaths))
        // First user message → kick off an AI-generated topic title (the derived
        // first-line title below is just an instant placeholder until it lands).
        if conversations[ci].messages.filter({ $0.role == .user }).count == 1,
           !conversations[ci].titleLocked {
            generateTitle(conversationID: cid, seed: trimmed.isEmpty ? "（图片）" : trimmed)
        }
        if conversations[ci].title == "新对话" {
            conversations[ci].title = Conversation.deriveTitle(from: trimmed.isEmpty ? "图片" : trimmed)
        }
        touch(cid)   // persist the user turn immediately

        // No model configured → answer locally instead of hitting the network.
        guard let model = settings.settings.llmModel.flatMap({ settings.settings.resolve($0) }) else {
            conversations[ci].messages.append(
                ChatMessage(role: .assistant,
                            content: "请先在「设置 → 模型」里配置一个大模型，并选为当前大模型。")
            )
            touch(cid)
            return
        }

        let assistant = ChatMessage(role: .assistant, content: "")
        let aid = assistant.id
        // Build the request history BEFORE adding the placeholder, dropping any
        // empty assistant turns (e.g. a prior interrupted reply) some strict
        // servers reject — but keeping tool-call turns, whose text may be empty
        // yet must stay paired with their tool results.
        let history = conversations[ci].messages.filter {
            !($0.role == .assistant && $0.content.trimmed.isEmpty && ($0.toolCalls ?? []).isEmpty)
        }
        conversations[ci].messages.append(assistant)

        let turnStart = Date()
        isStreaming = true
        streamingConversationID = cid
        streamingMessageID = aid
        streamStartedAt = turnStart
        liveOutputTokens = 0
        liveTokenAccum = 0
        streamTask = Task { [weak self] in
            guard let self else { return }
            // Output tokens accumulated across every round of this turn (the tool
            // loop can stream several times); frozen onto the final bubble below.
            var turnOutput = 0
            // The active agent decides both the persona (system prompt) and which
            // tools are on the table. Offer tools only when the model is flagged
            // tool-capable, on a wire the tool loop supports, and the agent has
            // enabled some registered tools.
            let agent = self.settings.settings.activeAgent
            let enabledTools = agent?.enabledTools ?? []
            let toolSpecs: [ToolSpec]
            if let cfg = self.settings.settings.llmModel,
               cfg.llmCapabilities.toolCalling,
               model.wire == .openAIChat || model.wire == .anthropicMessages,
               !enabledTools.isEmpty {
                toolSpecs = self.tools.specs.filter { enabledTools.contains($0.name) }
            } else {
                toolSpecs = []
            }
            // Reasoning effort is a persisted per-model setting, applied only to
            // thinking-capable models.
            let cfgModel = self.settings.settings.llmModel
            let thinkingCapable = cfgModel?.llmCapabilities.thinking ?? false
            let effort: String = thinkingCapable ? (cfgModel?.reasoningEffort ?? "") : ""

            var turn = history
            // Build the system turn from the agent's prompt plus the instructions
            // of every skill it has enabled (wire-adapted by ChatClient — a system
            // message for Chat, the `system` field for Anthropic).
            if let agent {
                var systemText = agent.systemPrompt.trimmed
                for skill in self.skills.skills where agent.enabledSkills.contains(skill.id) {
                    var block = "\n\n# 技能：\(skill.displayName)"
                    if !skill.description.isEmpty { block += "\n\(skill.description)" }
                    if !skill.instructions.isEmpty { block += "\n\n\(skill.instructions)" }
                    systemText += block
                }
                let trimmedSystem = systemText.trimmed
                if !trimmedSystem.isEmpty {
                    turn.insert(ChatMessage(role: .system, content: trimmedSystem), at: 0)
                }
            }
            var currentAID = aid
            var rounds = 0
            do {
                // The tool loop: stream → if the model requested tools, run them,
                // feed results back, and stream again — until a plain answer.
                while true {
                    let outcome = try await ChatClient.stream(
                        model: model, messages: turn, tools: toolSpecs, reasoning: effort
                    ) { piece in
                        self.appendDelta(piece, conversationID: cid, messageID: currentAID)
                        self.liveTokenAccum += ChatStore.estimateTokens(piece)
                        self.liveOutputTokens = Int(self.liveTokenAccum)
                    }
                    if let cfg = self.settings.settings.llmModel, !outcome.usage.isEmpty {
                        self.usage.add(self.settings.settings.usageRecord(
                            for: cfg, source: "chat", date: Date(), usage: outcome.usage))
                    }
                    turnOutput += outcome.usage.output ?? 0
                    // Snap the live counter to the provider's real figure, and
                    // record the turn's total context occupancy for the ring.
                    if outcome.usage.output != nil {
                        self.liveTokenAccum = Double(turnOutput)
                        self.liveOutputTokens = turnOutput
                    }
                    let ctx = (outcome.usage.input ?? 0) + (outcome.usage.output ?? 0)
                    if ctx > 0 { self.contextUsed[cid] = ctx }
                    guard !outcome.toolCalls.isEmpty, rounds < self.maxToolRounds else {
                        // Completed with no content at all → leave a visible note
                        // rather than a permanently empty bubble.
                        self.noteIfEmpty(conversationID: cid, messageID: currentAID)
                        break
                    }
                    rounds += 1

                    // Freeze this round's assistant turn (its text + the calls).
                    let assistantText = self.messageContent(conversationID: cid, messageID: currentAID) ?? ""
                    self.attachToolCalls(outcome.toolCalls, conversationID: cid, messageID: currentAID)
                    turn.append(ChatMessage(role: .assistant, content: assistantText,
                                            toolCalls: outcome.toolCalls))

                    // Run every requested tool; failures go back as tool errors so
                    // the model can react instead of the turn dying.
                    for call in outcome.toolCalls {
                        let toolMessage = await self.runTool(call)
                        self.appendMessage(toolMessage, conversationID: cid)
                        turn.append(toolMessage)
                    }

                    // Fresh assistant bubble for the model's follow-up round.
                    let next = ChatMessage(role: .assistant, content: "")
                    currentAID = next.id
                    self.appendMessage(next, conversationID: cid)
                    self.streamingMessageID = currentAID
                }
            } catch {
                if !Task.isCancelled && !(error is CancellationError) {
                    self.appendDelta("\n\n[出错] \(error.localizedDescription)",
                                     conversationID: cid, messageID: currentAID)
                }
            }
            // Freeze the turn's elapsed time + output tokens onto the final
            // assistant bubble so the footer persists after the stream ends.
            if let ci = self.conversations.firstIndex(where: { $0.id == cid }),
               let mi = self.conversations[ci].messages.firstIndex(where: { $0.id == currentAID }),
               self.conversations[ci].messages[mi].role == .assistant {
                self.conversations[ci].messages[mi].elapsed = Date().timeIntervalSince(turnStart)
                let finalTokens = turnOutput > 0 ? turnOutput : self.liveOutputTokens
                if finalTokens > 0 { self.conversations[ci].messages[mi].tokens = finalTokens }
            }
            self.isStreaming = false
            self.streamingConversationID = nil
            self.streamingMessageID = nil
            self.streamStartedAt = nil
            self.streamTask = nil
            self.touch(cid)   // persist the completed reply
        }
    }

    /// Execute one tool call and wrap the outcome as a `.tool` transcript message.
    private func runTool(_ call: ToolCall) async -> ChatMessage {
        let result: ToolResult
        var attachments: [String] = []
        if let tool = tools.tool(named: call.name) {
            do {
                let args = (try? JSONSerialization.jsonObject(
                    with: Data(call.argumentsJSON.utf8))) as? [String: Any] ?? [:]
                let output = try await tool.run(args)
                result = ToolResult(toolCallID: call.id, content: output.content, isError: false)
                attachments = output.attachments
            } catch {
                result = ToolResult(toolCallID: call.id,
                                    content: "工具执行失败：\(error.localizedDescription)",
                                    isError: true)
            }
        } else {
            result = ToolResult(toolCallID: call.id, content: "未知工具：\(call.name)", isError: true)
        }
        return ChatMessage(role: .tool, content: "", toolResult: result,
                           attachments: attachments.isEmpty ? nil : attachments)
    }

    private func appendDelta(_ piece: String, conversationID: UUID, messageID: UUID) {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }),
              let mi = conversations[ci].messages.firstIndex(where: { $0.id == messageID }) else { return }
        conversations[ci].messages[mi].content += piece
    }

    private func appendMessage(_ message: ChatMessage, conversationID: UUID) {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }) else { return }
        conversations[ci].messages.append(message)
    }

    private func messageContent(conversationID: UUID, messageID: UUID) -> String? {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }),
              let mi = conversations[ci].messages.firstIndex(where: { $0.id == messageID }) else { return nil }
        return conversations[ci].messages[mi].content
    }

    private func attachToolCalls(_ calls: [ToolCall], conversationID: UUID, messageID: UUID) {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }),
              let mi = conversations[ci].messages.firstIndex(where: { $0.id == messageID }) else { return }
        conversations[ci].messages[mi].toolCalls = calls
    }

    private func noteIfEmpty(conversationID: UUID, messageID: UUID) {
        guard let ci = conversations.firstIndex(where: { $0.id == conversationID }),
              let mi = conversations[ci].messages.firstIndex(where: { $0.id == messageID }),
              conversations[ci].messages[mi].content.isEmpty else { return }
        conversations[ci].messages[mi].content = "（模型没有返回内容）"
    }
}
