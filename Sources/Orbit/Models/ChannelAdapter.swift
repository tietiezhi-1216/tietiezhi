//  ChannelAdapter.swift
//  渠道商适配器 — a fixed, code-defined descriptor per vendor. This is the layer
//  the user actually picks: choose a channel, fill in the API key (and, for
//  self-hosted vendors, the base URL), and the adapter supplies everything else
//  the system used to make the user choose by hand — the auth scheme, the wire
//  protocol per capability, the default endpoint, how to discover models, and a
//  catalog of model metadata + pricing.
//
//  Design (validated against New API's channel-type → adaptor model and
//  LobeChat's model cards): the adapter is a *creation-time knowledge source*.
//  When a provider is added it stamps the adapter's `auth` / `wires` (as
//  `Service`s) / base URL onto the existing `Provider`, so the runtime
//  (`Settings.resolve`, `ChatClient`, `Transcriber`) reads the same fields as
//  before and needs no change. Most vendors are OpenAI-compatible and reuse one
//  wire; only genuinely different protocols (Anthropic, MiMo's audio-in-chat)
//  get their own wire — which the existing `Wire` enum already models.

import Foundation

/// How an adapter discovers the models it can serve.
enum ModelSource: Hashable {
    case remote            // GET /models is authoritative
    case catalog           // no list endpoint — use the built-in catalog only (MiMo)
    case remotePlusCatalog // fetch /models, enrich with catalog metadata/pricing
}

struct ChannelAdapter: Identifiable, Hashable {
    let id: String
    let displayName: String
    /// SF Symbol standing in for a brand mark until real icons are bundled.
    let symbol: String
    let defaultBaseURL: String
    /// Self-hosted / aggregator endpoints (New API, custom) let the user edit the
    /// base URL; fixed vendors (OpenAI, MiMo, …) do not.
    let baseURLEditable: Bool
    let auth: AuthScheme
    /// The wire each capability speaks. Chat is required; ASR etc. optional.
    let wires: [Capability: Wire]
    let modelSource: ModelSource
    /// Built-in model metadata + pricing (LobeChat-style cards).
    let catalog: [ModelCard]
    /// The "custom / OpenAI-compatible" escape hatch: base URL, auth, and the
    /// protocol set are user-editable (the pre-refactor manual flow lives here).
    let isCustom: Bool

    // MARK: Derived

    /// Best-matching catalog card for a raw model id (exact match first, then a
    /// prefix fallback so a whole family inherits sane defaults).
    func card(forModelID modelID: String) -> ModelCard? {
        catalog.first { !$0.matchByPrefix && $0.matches(modelID) }
            ?? catalog.first { $0.matchByPrefix && $0.matches(modelID) }
    }

    /// The wire this adapter uses for a capability.
    func wire(for capability: Capability) -> Wire? { wires[capability] }

    /// The `Service` catalog a freshly created provider of this adapter carries.
    /// (Chat first so it reads naturally in the UI.)
    func seededServices() -> [Service] {
        let ordered = wires.sorted { a, b in
            (a.key == .chat ? 0 : 1) < (b.key == .chat ? 0 : 1)
        }
        return ordered.map { Service(wire: $0.value) }
    }

    /// A ready-to-fill provider for this adapter (auth + services + base URL
    /// pre-stamped; the user only supplies key / name / optional URL override).
    func makeProvider(name: String? = nil) -> Provider {
        Provider(
            name: name ?? displayName,
            baseURL: defaultBaseURL,
            apiKey: "",
            auth: auth,
            services: isCustom ? [Service(wire: .openAIChat)] : seededServices(),
            adapterID: id
        )
    }
}

// MARK: - Registry

extension ChannelAdapter {
    static let customID = "custom"

    /// All built-in adapters, in menu order.
    static let all: [ChannelAdapter] = [
        openAI, mimo, siliconFlow, newAPI, anthropic,
        deepSeek, moonshot, zhipu, openRouter, custom,
    ]

    static func byID(_ id: String) -> ChannelAdapter? { all.first { $0.id == id } }

    /// Infer an adapter id for a legacy provider that predates this field, from
    /// its base URL + auth scheme. Falls back to "custom" so nothing is lost.
    static func inferID(baseURL: String, auth: AuthScheme) -> String {
        let u = baseURL.lowercased()
        if auth == .anthropic || u.contains("api.anthropic.com") { return "anthropic" }
        if u.contains("xiaomimimo") || u.contains("mimo") { return "mimo" }
        if u.contains("api.openai.com") { return "openai" }
        if u.contains("siliconflow") { return "siliconflow" }
        if u.contains("deepseek") { return "deepseek" }
        if u.contains("moonshot") { return "moonshot" }
        if u.contains("openrouter") { return "openrouter" }
        if u.contains("bigmodel") { return "zhipu" }
        return customID
    }

    // MARK: Adapters

    // Catalog cards carry only metadata (capability + feature flags) used to
    // classify auto-loaded models. Prices are NOT shipped — pricing is entirely
    // user-set per model (ModelConfig.pricingOverride); we never guess a default.
    private static let multimodalTools = LLMCapabilities(multimodal: true, thinking: false, toolCalling: true)
    private static let reasoningMMTools = LLMCapabilities(multimodal: true, thinking: true, toolCalling: true)

    static let openAI = ChannelAdapter(
        id: "openai", displayName: "OpenAI", symbol: "sparkles",
        defaultBaseURL: "https://api.openai.com/v1", baseURLEditable: false,
        auth: .bearer,
        wires: [.chat: .openAIChat, .asr: .openAITranscription, .image: .openAIImage, .video: .openAIVideo],
        modelSource: .remotePlusCatalog,
        catalog: [
            ModelCard("gpt-4o", name: "GPT-4o", abilities: multimodalTools, contextWindow: 128_000),
            ModelCard("gpt-4o-mini", name: "GPT-4o mini", abilities: multimodalTools, contextWindow: 128_000),
            ModelCard("gpt-4.1", name: "GPT-4.1", abilities: multimodalTools, contextWindow: 1_047_576),
            ModelCard("gpt-4o-transcribe", capability: .asr),
            ModelCard("gpt-4o-mini-transcribe", capability: .asr),
            ModelCard("whisper-1", name: "Whisper", capability: .asr),
            ModelCard("gpt-image-1", name: "GPT Image 1", capability: .image),
            ModelCard("dall-e-3", name: "DALL·E 3", capability: .image),
            ModelCard("sora-2", name: "Sora 2", capability: .video),
            ModelCard("sora-2-pro", name: "Sora 2 Pro", capability: .video),
        ],
        isCustom: false)

    static let mimo = ChannelAdapter(
        id: "mimo", displayName: "小米 MiMo", symbol: "m.circle",
        defaultBaseURL: "https://api.xiaomimimo.com/v1", baseURLEditable: false,
        auth: .bearer,          // MiMo also accepts api-key; bearer keeps it OpenAI-shaped
        wires: [.chat: .openAIChat, .asr: .mimoAudioASR],
        modelSource: .catalog,  // no /v1/models — must ship a catalog
        catalog: [
            ModelCard("mimo-v2.5-pro", name: "MiMo V2.5 Pro", capability: .chat,
                      abilities: reasoningMMTools),
            ModelCard("mimo-v2.5", name: "MiMo V2.5", capability: .chat,
                      abilities: LLMCapabilities(multimodal: false, thinking: false, toolCalling: true)),
            ModelCard("MiMo-V2.5-ASR", name: "MiMo V2.5 ASR", capability: .asr),
        ],
        isCustom: false)

    static let siliconFlow = ChannelAdapter(
        id: "siliconflow", displayName: "SiliconFlow 硅基流动", symbol: "flowchart",
        defaultBaseURL: "https://api.siliconflow.cn/v1", baseURLEditable: false,
        auth: .bearer,
        wires: [.chat: .openAIChat, .asr: .openAITranscription,
                .image: .siliconflowImage, .video: .siliconflowVideo],
        modelSource: .remote,
        catalog: [
            ModelCard("Kwai-Kolors/Kolors", name: "Kolors", capability: .image),
            ModelCard("black-forest-labs/FLUX.1-schnell", name: "FLUX.1 schnell", capability: .image),
            ModelCard("Wan-AI/Wan2.2-T2V-A14B", name: "Wan2.2 T2V", capability: .video),
        ],
        isCustom: false)

    static let newAPI = ChannelAdapter(
        id: "newapi", displayName: "New API（自托管）", symbol: "server.rack",
        defaultBaseURL: "", baseURLEditable: true,   // user's own host + /v1
        auth: .bearer,
        wires: [.chat: .openAIChat, .asr: .openAITranscription, .image: .openAIImage],
        modelSource: .remote,
        catalog: [],
        isCustom: false)

    static let anthropic = ChannelAdapter(
        id: "anthropic", displayName: "Anthropic (Claude)", symbol: "a.circle",
        defaultBaseURL: "https://api.anthropic.com", baseURLEditable: false,
        auth: .anthropic,
        wires: [.chat: .anthropicMessages],
        modelSource: .remotePlusCatalog,
        catalog: [
            // Prefix cards so dated ids (claude-3-5-sonnet-20241022) still match;
            // used only for capability/feature-flag metadata, not pricing.
            ModelCard("claude-3-opus", name: "Claude 3 Opus", abilities: multimodalTools,
                      contextWindow: 200_000, matchByPrefix: true),
            ModelCard("claude-opus", name: "Claude Opus", abilities: reasoningMMTools,
                      contextWindow: 200_000, matchByPrefix: true),
            ModelCard("claude-sonnet", name: "Claude Sonnet", abilities: reasoningMMTools,
                      contextWindow: 200_000, matchByPrefix: true),
            ModelCard("claude-3-5-sonnet", name: "Claude 3.5 Sonnet", abilities: multimodalTools,
                      contextWindow: 200_000, matchByPrefix: true),
            ModelCard("claude-haiku", name: "Claude Haiku", abilities: multimodalTools,
                      contextWindow: 200_000, matchByPrefix: true),
            ModelCard("claude-3-5-haiku", name: "Claude 3.5 Haiku", abilities: multimodalTools,
                      contextWindow: 200_000, matchByPrefix: true),
        ],
        isCustom: false)

    static let deepSeek = ChannelAdapter(
        id: "deepseek", displayName: "DeepSeek 深度求索", symbol: "magnifyingglass.circle",
        defaultBaseURL: "https://api.deepseek.com", baseURLEditable: false,
        auth: .bearer,
        wires: [.chat: .openAIChat],
        modelSource: .remotePlusCatalog,
        catalog: [],
        isCustom: false)

    static let moonshot = ChannelAdapter(
        id: "moonshot", displayName: "Moonshot 月之暗面 (Kimi)", symbol: "moon.circle",
        defaultBaseURL: "https://api.moonshot.cn/v1", baseURLEditable: false,
        auth: .bearer,
        wires: [.chat: .openAIChat],
        modelSource: .remotePlusCatalog,
        catalog: [],
        isCustom: false)

    static let zhipu = ChannelAdapter(
        id: "zhipu", displayName: "智谱 GLM", symbol: "z.circle",
        defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4", baseURLEditable: false,
        auth: .bearer,
        wires: [.chat: .openAIChat],
        modelSource: .remotePlusCatalog,
        catalog: [],
        isCustom: false)

    static let openRouter = ChannelAdapter(
        id: "openrouter", displayName: "OpenRouter", symbol: "arrow.triangle.branch",
        defaultBaseURL: "https://openrouter.ai/api/v1", baseURLEditable: false,
        auth: .bearer,
        wires: [.chat: .openAIChat],
        modelSource: .remote,
        catalog: [],
        isCustom: false)

    static let custom = ChannelAdapter(
        id: customID, displayName: "自定义 / OpenAI 兼容", symbol: "slider.horizontal.3",
        defaultBaseURL: "", baseURLEditable: true,
        auth: .bearer,
        wires: [.chat: .openAIChat, .asr: .openAITranscription, .image: .openAIImage],
        modelSource: .remote,
        catalog: [],
        isCustom: true)

    /// Best-guess capability for a bare model id (from `/v1/models`, which is just
    /// a list of names). Used when auto-loading a channel's models. Defaults to
    /// chat — the overwhelming common case.
    static func inferCapability(_ id: String) -> Capability {
        let s = id.lowercased()
        if s.contains("whisper") || s.contains("transcrib") || s.contains("asr") || s.contains("stt") { return .asr }
        if s.contains("tts") || s.contains("-speech") || s.hasSuffix("speech") { return .tts }
        if s.contains("embed") || s.contains("bge-") || s.contains("gte-") { return .embedding }
        if s.contains("rerank") { return .rerank }
        if s.contains("video") || s.contains("sora") || s.contains("kling") || s.contains("cogvideo")
            || s.contains("wan-") || s.contains("t2v") || s.contains("i2v") { return .video }
        if s.contains("image") || s.contains("dall-e") || s.contains("stable-diffusion") || s.contains("sdxl")
            || s.contains("sd3") || s.contains("flux") || s.contains("kolors") || s.contains("midjourney") { return .image }
        return .chat
    }
}
