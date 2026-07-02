//  ModelCard.swift
//  Code-defined model metadata + pricing, keyed under a ChannelAdapter's catalog.
//
//  Vendors don't publish a machine-readable price feed, and "what a model is"
//  (its capability, whether it's multimodal / reasoning / tool-calling, its
//  context window, its price) should be system knowledge — not something the
//  user hand-configures. So each adapter ships a catalog of `ModelCard`s
//  (inspired by LobeChat's model cards). A fetched or user-typed model id is
//  matched against the catalog to inherit this metadata; the user can still
//  override the price per model via `ModelConfig.pricingOverride`.

import Foundation

/// Per-1M-token / per-call / per-audio-minute pricing for a model. Currency is
/// explicit because vendors quote in different currencies (USD vs CNY). Codable
/// because it is both a code-defined default (in a `ModelCard`) and a
/// user-persisted override (`ModelConfig.pricingOverride`) and is copied onto
/// each `UsageRecord` so historical cost stays stable when prices change.
struct ModelPricing: Codable, Hashable {
    /// Input (prompt) price per 1,000,000 tokens.
    var inputPer1M: Double?
    /// Output (completion) price per 1,000,000 tokens.
    var outputPer1M: Double?
    /// Cached-input price per 1,000,000 tokens (prompt caching), when offered.
    var cachedInputPer1M: Double?
    /// Flat price per call, for models billed per request (some image models).
    var perCall: Double?
    /// Price per minute of audio, for ASR billed by duration (e.g. MiMo).
    var perAudioMinute: Double?
    /// ISO-ish currency code, e.g. "USD" / "CNY".
    var currency: String

    init(inputPer1M: Double? = nil,
         outputPer1M: Double? = nil,
         cachedInputPer1M: Double? = nil,
         perCall: Double? = nil,
         perAudioMinute: Double? = nil,
         currency: String = "USD") {
        self.inputPer1M = inputPer1M
        self.outputPer1M = outputPer1M
        self.cachedInputPer1M = cachedInputPer1M
        self.perCall = perCall
        self.perAudioMinute = perAudioMinute
        self.currency = currency
    }

    /// True when nothing is priced — used to decide whether to show a price at all.
    var isEmpty: Bool {
        inputPer1M == nil && outputPer1M == nil && cachedInputPer1M == nil
            && perCall == nil && perAudioMinute == nil
    }

    /// Currency symbol for display.
    var symbol: String {
        switch currency.uppercased() {
        case "CNY", "RMB": return "¥"
        case "USD": return "$"
        default: return currency + " "
        }
    }

    /// Compute the cost of one call from measured usage. Returns nil when nothing
    /// applicable is priced. Token prices are per 1,000,000 tokens; audio per minute.
    func cost(inputTokens: Int? = nil,
              outputTokens: Int? = nil,
              cachedInputTokens: Int? = nil,
              audioSeconds: Double? = nil) -> Double? {
        var total = 0.0
        var any = false
        if let rate = inputPer1M, let n = inputTokens { total += Double(n) / 1_000_000 * rate; any = true }
        if let rate = outputPer1M, let n = outputTokens { total += Double(n) / 1_000_000 * rate; any = true }
        if let rate = cachedInputPer1M, let n = cachedInputTokens { total += Double(n) / 1_000_000 * rate; any = true }
        if let rate = perAudioMinute, let s = audioSeconds { total += s / 60 * rate; any = true }
        if let flat = perCall { total += flat; any = true }
        return any ? total : nil
    }

    /// One-line price label, e.g. "$2.5 / $10 每百万" or "¥0.5/分钟".
    var displaySummary: String {
        if let m = perAudioMinute { return "\(symbol)\(trim(m))/分钟" }
        if let inTok = inputPer1M {
            let out = outputPer1M.map { " / \(symbol)\(trim($0))" } ?? ""
            return "\(symbol)\(trim(inTok))\(out) 每百万"
        }
        if let flat = perCall { return "\(symbol)\(trim(flat))/次" }
        return "—"
    }

    private func trim(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(format: "%g", v)
    }
}

/// A code-defined description of one model an adapter knows about: its capability
/// (so the system fixes the type, not the user), feature flags, context window,
/// and price. `id` is either an exact model id or, when `matchByPrefix`, a prefix
/// used as a fallback so a whole model family inherits sane defaults.
struct ModelCard: Identifiable, Hashable {
    var id: String
    var matchByPrefix: Bool
    var displayName: String
    var capability: Capability
    var abilities: LLMCapabilities
    var contextWindow: Int?
    var pricing: ModelPricing?

    init(_ id: String,
         name: String? = nil,
         capability: Capability = .chat,
         abilities: LLMCapabilities = .none,
         contextWindow: Int? = nil,
         pricing: ModelPricing? = nil,
         matchByPrefix: Bool = false) {
        self.id = id
        self.matchByPrefix = matchByPrefix
        self.displayName = name ?? id
        self.capability = capability
        self.abilities = abilities
        self.contextWindow = contextWindow
        self.pricing = pricing
    }

    /// Whether this card describes the given raw model id.
    func matches(_ modelID: String) -> Bool {
        matchByPrefix ? modelID.hasPrefix(id) : modelID == id
    }
}
