//  Usage.swift
//  Token / audio usage surfaced by the networking layer, plus the persisted
//  record the app accumulates for cost accounting. The networking layer only
//  *surfaces* usage (`TokenUsage`); the high-level stores (ChatStore /
//  DictationQueue) build a `UsageRecord` — computing cost from the model's
//  effective pricing — and hand it to `UsageStore`.

import Foundation

/// Raw usage numbers parsed from a provider response. Merged as chunks arrive
/// (Anthropic reports input at message start and output at message delta).
struct TokenUsage: Hashable {
    var input: Int?
    var output: Int?
    var cachedInput: Int?

    var isEmpty: Bool { input == nil && output == nil && cachedInput == nil }

    /// Fold another partial reading in, preferring newer non-nil values.
    mutating func merge(_ other: TokenUsage) {
        if let v = other.input { input = v }
        if let v = other.output { output = v }
        if let v = other.cachedInput { cachedInput = v }
    }
}

/// One billable event (a chat reply, a dictation transcription, a polish pass),
/// with cost frozen at record time so historical totals don't shift when the
/// code-defined price table changes.
struct UsageRecord: Codable, Identifiable, Hashable {
    var id: String
    var date: Date
    var providerID: String
    var adapterID: String
    /// The raw provider model id (e.g. `gpt-4o-mini`).
    var modelID: String
    /// Display label used at record time (`渠道商/模型ID`), so stats read well
    /// even if the model is later renamed or deleted.
    var label: String
    var capability: Capability
    var inputTokens: Int?
    var outputTokens: Int?
    var cachedInputTokens: Int?
    var audioSeconds: Double?
    var cost: Double?
    var currency: String?
    /// "chat" / "asr" / "polish".
    var source: String

    init(id: String = UUID().uuidString,
         date: Date,
         providerID: String,
         adapterID: String,
         modelID: String,
         label: String,
         capability: Capability,
         inputTokens: Int? = nil,
         outputTokens: Int? = nil,
         cachedInputTokens: Int? = nil,
         audioSeconds: Double? = nil,
         cost: Double? = nil,
         currency: String? = nil,
         source: String) {
        self.id = id
        self.date = date
        self.providerID = providerID
        self.adapterID = adapterID
        self.modelID = modelID
        self.label = label
        self.capability = capability
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cachedInputTokens = cachedInputTokens
        self.audioSeconds = audioSeconds
        self.cost = cost
        self.currency = currency
        self.source = source
    }

    var totalTokens: Int { (inputTokens ?? 0) + (outputTokens ?? 0) }
}
