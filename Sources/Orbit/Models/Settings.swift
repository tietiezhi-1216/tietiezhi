//  Settings.swift
//  Typed configuration model.
//
//  Altitude of the wire protocol: a provider is just credentials + a base URL.
//  WHAT interface a model speaks (chat completions vs. responses vs. an image /
//  video / embedding endpoint) is NOT a provider-wide fact — one base URL can
//  host many models that each speak a different protocol. So the provider owns a
//  "service catalog" (`[Service]`), and each `ModelConfig` attaches to one of
//  those services. The service decides the capability, the wire format, and the
//  endpoint path; the provider only contributes base URL + key + auth scheme.
//
//  Persisted as JSON by `SettingsStore`. Decoding is tolerant of older configs:
//  the previous provider-level `api` (openAIChat / openAIResponses / anthropic)
//  and model-level `kind` (asr / llm) are read and migrated (see the custom
//  decoders below + `SettingsStore.migrate`), with no data loss.

import Foundation

// MARK: - Capability

/// What a model is for. Drives which call site handles it and which settings
/// section it shows under. `chat` subsumes the old `.llm`.
enum Capability: String, Codable, Hashable, CaseIterable, Identifiable {
    case chat        // text in → text out (streaming)
    case embedding   // text in → vector out
    case image       // prompt → image
    case video       // prompt → video (usually async submit + poll)
    case asr         // audio → text
    case tts         // text → audio
    case rerank      // query + docs → scores

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .chat:      return "聊天 / 大模型"
        case .embedding: return "向量嵌入"
        case .image:     return "图像生成"
        case .video:     return "视频生成"
        case .asr:       return "语音识别"
        case .tts:       return "语音合成"
        case .rerank:    return "重排序"
        }
    }

    var symbol: String {
        switch self {
        case .chat:      return "bubble.left.and.bubble.right"
        case .embedding: return "point.3.connected.trianglepath.dotted"
        case .image:     return "photo"
        case .video:     return "film"
        case .asr:       return "waveform"
        case .tts:       return "speaker.wave.2"
        case .rerank:    return "arrow.up.arrow.down"
        }
    }
}

// MARK: - Wire protocol

/// A normalized API protocol (spec). It fully decides the endpoint path, the
/// request body shape, and the response / stream parse — the user never types a
/// URL, they only pick one of these. Auth lives on the provider (`AuthScheme`);
/// a wire only contributes any *protocol* headers (e.g. Anthropic's
/// `anthropic-version`). New protocols (e.g. Google Gemini) are added here, one
/// adapter at a time — only protocols actually implemented appear in the UI.
enum Wire: String, Codable, Hashable, CaseIterable, Identifiable {
    // LLM (chat)
    case openAIChat          // POST {base}/chat/completions
    case openAIResponses     // POST {base}/responses
    case anthropicMessages   // POST {base}/v1/messages
    // ASR (speech → text)
    case openAITranscription // POST {base}/audio/transcriptions (multipart, Whisper-style)
    case mimoAudioASR        // POST {base}/chat/completions (audio as input_audio content)
    // Image (prompt → image)
    case openAIImage         // POST {base}/images/generations (OpenAI 兼容)
    case siliconflowImage    // POST {base}/images/generations (SiliconFlow 变体：image_size/batch_size)
    // Video (prompt → video; async submit + poll, multi-endpoint — VideoClient
    // derives the poll/download paths from the base URL per wire)
    case siliconflowVideo    // POST {base}/video/submit → POST {base}/video/status
    case openAIVideo         // POST {base}/videos (Sora, multipart) → GET {base}/videos/{id} → …/content

    var id: String { rawValue }

    /// The capability (function) this protocol implements.
    var capability: Capability {
        switch self {
        case .openAIChat, .openAIResponses, .anthropicMessages: return .chat
        case .openAITranscription, .mimoAudioASR:               return .asr
        case .openAIImage, .siliconflowImage:                   return .image
        case .siliconflowVideo, .openAIVideo:                   return .video
        }
    }

    var displayName: String {
        switch self {
        case .openAIChat:          return "OpenAI Chat Completions"
        case .openAIResponses:     return "OpenAI Responses"
        case .anthropicMessages:   return "Anthropic Messages"
        case .openAITranscription: return "OpenAI Transcription"
        case .mimoAudioASR:        return "MiMo 音频识别（Chat）"
        case .openAIImage:         return "图像生成（OpenAI 兼容）"
        case .siliconflowImage:    return "图像生成（SiliconFlow）"
        case .siliconflowVideo:    return "视频生成（SiliconFlow）"
        case .openAIVideo:         return "视频生成（Sora）"
        }
    }

    /// One-line hint — the real endpoint this protocol talks to.
    var summary: String {
        switch self {
        case .openAIChat:          return "POST /chat/completions —— 兼容绝大多数服务商"
        case .openAIResponses:     return "POST /responses —— OpenAI 新一代接口"
        case .anthropicMessages:   return "POST /v1/messages —— Claude 原生接口"
        case .openAITranscription: return "POST /audio/transcriptions —— 语音转写（multipart）"
        case .mimoAudioASR:        return "POST /chat/completions —— 音频内嵌 chat（input_audio）"
        case .openAIImage:         return "POST /images/generations —— OpenAI 兼容图像"
        case .siliconflowImage:    return "POST /images/generations —— SiliconFlow 图像变体"
        case .siliconflowVideo:    return "POST /video/submit + /video/status —— 异步提交轮询"
        case .openAIVideo:         return "POST /videos —— Sora 异步生成"
        }
    }

    /// The endpoint path appended to the provider's base URL — fixed by the spec.
    var defaultPath: String {
        switch self {
        case .openAIChat:          return "/chat/completions"
        case .openAIResponses:     return "/responses"
        case .anthropicMessages:   return "/v1/messages"
        case .openAITranscription: return "/audio/transcriptions"
        case .mimoAudioASR:        return "/chat/completions"
        case .openAIImage, .siliconflowImage: return "/images/generations"
        case .siliconflowVideo:               return "/video/submit"
        case .openAIVideo:                    return "/videos"
        }
    }

    /// Apply any non-auth protocol headers this wire requires.
    func applyProtocolHeaders(_ req: inout URLRequest) {
        if self == .anthropicMessages {
            req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        }
    }

    /// The implemented protocols for a given capability.
    static func all(for capability: Capability) -> [Wire] {
        allCases.filter { $0.capability == capability }
    }
}

// MARK: - Auth scheme

/// How requests to a provider are signed. Tied to the API key, so it lives on
/// the provider rather than the wire.
enum AuthScheme: String, Codable, Hashable, CaseIterable, Identifiable {
    case bearer       // Authorization: Bearer <key>  — OpenAI & most aggregators
    case anthropic    // x-api-key: <key>             — Anthropic
    case apiKey       // api-key: <key>               — MiMo / Azure OpenAI

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .bearer:    return "Bearer（OpenAI 兼容）"
        case .anthropic: return "x-api-key（Anthropic）"
        case .apiKey:    return "api-key（MiMo / Azure）"
        }
    }

    func authorize(_ req: inout URLRequest, apiKey: String) {
        switch self {
        case .bearer:    req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        case .anthropic: req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        case .apiKey:    req.setValue(apiKey, forHTTPHeaderField: "api-key")
        }
    }

    /// `GET` list-models path for this scheme (OpenAI bases carry `/v1`,
    /// Anthropic owns `/v1/...` itself).
    var modelsPath: String {
        switch self {
        case .bearer, .apiKey: return "/models"
        case .anthropic:       return "/v1/models"
        }
    }
}

// MARK: - Service

/// One protocol a provider supports. It is just a normalized `Wire` (the spec) —
/// no name, no path, nothing to hand-edit. The capability and endpoint are
/// derived from the wire. Models attach to a service by id.
///
/// Decoding tolerates the earlier richer shape (`capability` / `label` / `path`
/// keys) — those keys are simply ignored, the wire is what matters.
struct Service: Identifiable, Codable, Hashable {
    var id: String
    var wire: Wire

    init(id: String = UUID().uuidString, wire: Wire) {
        self.id = id
        self.wire = wire
    }

    private enum CodingKeys: String, CodingKey { case id, wire }

    var capability: Capability { wire.capability }
    var endpointPath: String { wire.defaultPath }

    func endpoint(base: String) -> URL? {
        URL(string: base.trimmed.trimmingTrailingSlash + wire.defaultPath)
    }

    /// The default protocols a freshly created (or legacy) provider gets. The
    /// `legacyAPI` string (a previous provider-level `api` value) is honoured so
    /// existing OpenAI-Responses / Anthropic users keep their exact protocol.
    static func seedCatalog(legacyAPI: String?) -> [Service] {
        let chatWire: Wire
        switch legacyAPI {
        case "openAIResponses": chatWire = .openAIResponses
        case "anthropic":       chatWire = .anthropicMessages
        default:                chatWire = .openAIChat
        }
        var catalog = [Service(wire: chatWire)]
        // Anthropic endpoints have no audio API; OpenAI-style ones historically
        // served ASR (the old code hardcoded /audio/transcriptions), so seed it.
        if legacyAPI != "anthropic" {
            catalog.append(Service(wire: .openAITranscription))
        }
        return catalog
    }
}

// MARK: - Provider

/// A model vendor / endpoint — a base URL + API key + auth scheme, plus the
/// catalog of services (interfaces) it offers.
struct Provider: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    /// Base URL the service paths are appended to, e.g. `https://api.openai.com/v1`
    /// (OpenAI) or `https://api.anthropic.com` (Anthropic).
    var baseURL: String
    var apiKey: String
    var auth: AuthScheme
    var services: [Service]
    /// Which `ChannelAdapter` this provider is an instance of. The adapter fixes
    /// auth / wires / default base URL at creation; this id lets the UI hide the
    /// manual protocol controls and lets model lookups find the metadata/pricing
    /// catalog. Legacy configs without it are inferred in `init(from:)`.
    var adapterID: String

    init(id: String = UUID().uuidString,
         name: String,
         baseURL: String = Provider.openAIBase,
         apiKey: String = "",
         auth: AuthScheme = .bearer,
         services: [Service]? = nil,
         adapterID: String = ChannelAdapter.customID) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.auth = auth
        self.services = services ?? Service.seedCatalog(legacyAPI: nil)
        self.adapterID = adapterID
    }

    static let openAIBase = "https://api.openai.com/v1"

    private enum CodingKeys: String, CodingKey {
        case id, name, baseURL, apiKey, auth, services, adapterID
        case api // legacy (provider-level protocol); decode-only.
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Provider"
        baseURL = try c.decodeIfPresent(String.self, forKey: .baseURL) ?? Provider.openAIBase
        apiKey = try c.decodeIfPresent(String.self, forKey: .apiKey) ?? ""

        // Legacy provider-level protocol string, still present in old configs.
        // Read it WHILE it's in hand — it carries the openAIChat/Responses/
        // anthropic distinction that the new model can no longer represent on
        // the provider, and we must not lose it.
        let legacyAPI = try? c.decode(String.self, forKey: .api)

        if let a = try? c.decode(AuthScheme.self, forKey: .auth) {
            auth = a
        } else {
            auth = (legacyAPI == "anthropic") ? .anthropic : .bearer
        }

        if let s = try? c.decode([Service].self, forKey: .services), !s.isEmpty {
            services = s
        } else {
            services = Service.seedCatalog(legacyAPI: legacyAPI)
        }

        // New field: absent in old configs → infer from base URL + auth so an
        // existing provider still maps to an adapter (falls back to "custom").
        adapterID = try c.decodeIfPresent(String.self, forKey: .adapterID)
            ?? ChannelAdapter.inferID(baseURL: baseURL, auth: auth)
    }

    /// Explicit so the decode-only legacy `api` key is never written back.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(baseURL, forKey: .baseURL)
        try c.encode(apiKey, forKey: .apiKey)
        try c.encode(auth, forKey: .auth)
        try c.encode(services, forKey: .services)
        try c.encode(adapterID, forKey: .adapterID)
    }

    var modelsEndpoint: URL? {
        URL(string: baseURL.trimmed.trimmingTrailingSlash + auth.modelsPath)
    }

    func services(for capability: Capability) -> [Service] {
        services.filter { $0.capability == capability }
    }
}

// MARK: - Model

/// Legacy model role, kept only to migrate old configs (`kind: asr | llm`).
enum ModelKind: String, Codable, Hashable {
    case asr
    case llm

    var capability: Capability { self == .asr ? .asr : .chat }
}

/// Explicit user-managed capability flags for LLM/chat models. Defaults are
/// intentionally "no" so old or imported models never silently claim support
/// for multimodal input, reasoning/thinking, or tool calling.
struct LLMCapabilities: Codable, Hashable {
    var multimodal: Bool
    var thinking: Bool
    var toolCalling: Bool

    static let none = LLMCapabilities(multimodal: false, thinking: false, toolCalling: false)

    var summary: String {
        [
            "多模态：\(multimodal ? "是" : "否")",
            "思考：\(thinking ? "是" : "否")",
            "工具：\(toolCalling ? "是" : "否")"
        ].joined(separator: " · ")
    }
}

/// A concrete model belonging to a provider, attached to one of the provider's
/// services. The service decides the capability / wire / endpoint.
struct ModelConfig: Identifiable, Codable, Hashable {
    var id: String
    var providerID: String
    /// The provider service this model speaks through. Optional only so legacy
    /// configs decode; `SettingsStore.migrate` backfills it.
    var serviceID: String?
    /// Human-facing label.
    var name: String
    /// The provider's model identifier, e.g. `gpt-4o-transcribe`, `gpt-4o-mini`.
    var model: String
    /// Optional BCP-47-ish language hint, e.g. `zh` / `en` (ASR).
    var language: String?
    /// Capability-specific extra params (e.g. image size, tts voice). Free-form.
    var params: [String: String]?
    /// LLM-only feature flags surfaced in model lists and chat selection.
    var llmCapabilities: LLMCapabilities
    /// User override of the adapter catalog's price for this model. When nil the
    /// effective price comes from the adapter's `ModelCard` (see
    /// `Settings.effectivePricing`).
    var pricingOverride: ModelPricing?
    /// Persisted per-model reasoning effort (thinking-capable models only), as the
    /// raw `reasoning_effort` string ("" = off). Written by the composer's 思考
    /// menu so the choice survives restarts and each model remembers its own level.
    var reasoningEffort: String
    /// The effort levels this model actually offers. Empty = use the standard
    /// default set; populated by probing (`ProviderAPI.probeReasoning`) or edited
    /// by hand. Persisted. Free-form strings (some models add max / ultra / …).
    var reasoningLevels: [String]

    /// Levels the picker shows: the configured set, or the standard default.
    var availableEfforts: [String] {
        reasoningLevels.isEmpty ? ReasoningLevels.defaults : reasoningLevels
    }

    /// Transient: the role read from a legacy config, used by `migrate` to pick
    /// a service. Never persisted.
    var legacyKind: ModelKind?

    init(id: String = UUID().uuidString,
         providerID: String,
         serviceID: String?,
         name: String,
         model: String,
         language: String? = nil,
         params: [String: String]? = nil,
         llmCapabilities: LLMCapabilities = .none,
         pricingOverride: ModelPricing? = nil,
         reasoningEffort: String = "",
         reasoningLevels: [String] = []) {
        self.id = id
        self.providerID = providerID
        self.serviceID = serviceID
        self.name = name
        self.model = model
        self.language = language
        self.params = params
        self.llmCapabilities = llmCapabilities
        self.pricingOverride = pricingOverride
        self.reasoningEffort = reasoningEffort
        self.reasoningLevels = reasoningLevels
        self.legacyKind = nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, providerID, serviceID, name, model, language, params, llmCapabilities
        case pricingOverride, reasoningEffort, reasoningLevels
        case kind       // legacy role; decode-only.
        case transport  // legacy transport; ignored.
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        providerID = try c.decodeIfPresent(String.self, forKey: .providerID) ?? ""
        serviceID = try c.decodeIfPresent(String.self, forKey: .serviceID)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Model"
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        language = try c.decodeIfPresent(String.self, forKey: .language)
        params = try c.decodeIfPresent([String: String].self, forKey: .params)
        llmCapabilities = (try? c.decode(LLMCapabilities.self, forKey: .llmCapabilities)) ?? .none
        pricingOverride = try? c.decode(ModelPricing.self, forKey: .pricingOverride)
        reasoningEffort = (try? c.decode(String.self, forKey: .reasoningEffort)) ?? ""
        reasoningLevels = (try? c.decode([String].self, forKey: .reasoningLevels)) ?? []
        legacyKind = try? c.decode(ModelKind.self, forKey: .kind)
        // Old `transport` (http / realtime_ws / volcano_ws) no longer exists.
    }

    /// Custom so the transient `legacyKind` is never written to disk.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(providerID, forKey: .providerID)
        try c.encodeIfPresent(serviceID, forKey: .serviceID)
        try c.encode(name, forKey: .name)
        try c.encode(model, forKey: .model)
        try c.encodeIfPresent(language, forKey: .language)
        try c.encodeIfPresent(params, forKey: .params)
        try c.encode(llmCapabilities, forKey: .llmCapabilities)
        try c.encodeIfPresent(pricingOverride, forKey: .pricingOverride)
        try c.encode(reasoningEffort, forKey: .reasoningEffort)
        try c.encode(reasoningLevels, forKey: .reasoningLevels)
    }
}

// MARK: - MCP server

/// A user-configured external MCP server. `stdio` servers are spawned as a
/// subprocess from a shell command line (so `npx …` / `uvx …` work); `http`
/// servers are reached at a URL (Streamable HTTP). Tools they expose join the
/// same ToolRegistry as built-in skills.
struct MCPServerConfig: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    /// "stdio" or "http".
    var kind: String
    /// Full command line for stdio servers, e.g. `npx -y @modelcontextprotocol/server-filesystem ~/Documents`.
    var command: String
    /// Endpoint URL for http servers.
    var url: String
    var enabled: Bool

    init(id: String = UUID().uuidString,
         name: String = "",
         kind: String = "stdio",
         command: String = "",
         url: String = "",
         enabled: Bool = true) {
        self.id = id
        self.name = name
        self.kind = kind
        self.command = command
        self.url = url
        self.enabled = enabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "MCP"
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "stdio"
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        url = try c.decodeIfPresent(String.self, forKey: .url) ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
}

// MARK: - Prompt template

/// A reusable polish prompt. The placeholder (default `{{transcript}}`) marks
/// where the recognized text is injected.
struct PromptTemplate: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var template: String

    init(id: String = UUID().uuidString, name: String, template: String) {
        self.id = id
        self.name = name
        self.template = template
    }
}

// MARK: - Settings (the full persisted document)

struct Settings: Codable {
    var providers: [Provider]
    var models: [ModelConfig]
    var templates: [PromptTemplate]
    /// macOS virtual keycode (as a string) that toggles dictation. `54` = right ⌘.
    var hotkey: String
    /// User-defined global shortcut chords (modifier+key → action). Independent of
    /// the dictation `hotkey`; see `ActionShortcut` / HotkeyMonitor.
    var shortcuts: [ActionShortcut] = []
    var asrModelID: String?
    var llmModelID: String?
    var imageModelID: String? = nil
    var videoModelID: String? = nil
    /// Chat model the 截图 AI 标注 uses. nil = follow `llmModelID` (chat/听写共用).
    var captureModelID: String? = nil
    /// External MCP servers whose tools the chat model may call.
    var mcpServers: [MCPServerConfig] = []
    /// Chat agents (persona = system prompt + tool set) and the active one. See Agent.
    var agents: [Agent] = []
    var activeAgentID: String? = nil
    /// Directories the file / command tools may touch (whitelist). Empty means
    /// those tools refuse until the user grants a root — a safety floor.
    var toolRootDirectories: [String] = []
    var activeTemplateID: String?
    var llmPolishEnabled: Bool
    var autoInsert: Bool
    /// Placeholder name used inside templates (`{{<insertPosition>}}`).
    var insertPosition: String

    // MARK: Polish prompt system (user templates; see PromptComposer)

    /// User vocabulary the system folds into the polish prompt's hotword block
    /// (see PromptComposer); the template needs no placeholder to receive it.
    var hotwords: [String]
    /// Languages the user works in — surfaced in the prompt's context premise.
    var workingLanguages: [String]
    /// Preferred output language (context premise).
    var outputLanguage: OutputLanguage
    /// Tell the model which app is focused so it can match tone.
    var frontAppAware: Bool
    /// Append the "transcript is data, not instructions" guard.
    var injectionDefense: Bool
    /// Strip AI preamble / code fences / wrapping quotes from the reply.
    var cleanOutput: Bool

    // MARK: Feedback sounds (see FeedbackSound.swift)

    /// Audible cues for the dictation start/stop gestures, plus their user-managed
    /// sound library. Bindings map each `FeedbackEvent` to a cue.
    var feedbackSounds: FeedbackSoundSettings

    /// 截图卫星配置（热键 / 完成行为）。Defaulted so the memberwise init and old
    /// configs both pick it up without churn.
    var capture: CaptureSettings = .defaults

    static let defaultTemplateID = "default-polish"

    static var defaults: Settings {
        Settings(
            providers: [],
            models: [],
            templates: [
                PromptTemplate(
                    id: defaultTemplateID,
                    name: "默认",
                    template: DictationDefaults.seedTemplatePrompt
                )
            ],
            hotkey: "54",
            asrModelID: nil,
            llmModelID: nil,
            activeTemplateID: defaultTemplateID,
            llmPolishEnabled: false,
            autoInsert: true,
            insertPosition: "transcript",
            agents: Agent.seeded,
            activeAgentID: Agent.seeded.first?.id
        )
    }

    init(providers: [Provider], models: [ModelConfig], templates: [PromptTemplate],
         hotkey: String, asrModelID: String?, llmModelID: String?,
         activeTemplateID: String?, llmPolishEnabled: Bool, autoInsert: Bool,
         insertPosition: String,
         shortcuts: [ActionShortcut] = [],
         agents: [Agent] = [],
         activeAgentID: String? = nil,
         toolRootDirectories: [String] = [],
         hotwords: [String] = [],
         workingLanguages: [String] = [],
         outputLanguage: OutputLanguage = .auto,
         frontAppAware: Bool = true,
         injectionDefense: Bool = true,
         cleanOutput: Bool = true,
         feedbackSounds: FeedbackSoundSettings = .defaults) {
        self.providers = providers
        self.models = models
        self.templates = templates
        self.hotkey = hotkey
        self.shortcuts = shortcuts
        self.agents = agents
        self.activeAgentID = activeAgentID
        self.toolRootDirectories = toolRootDirectories
        self.asrModelID = asrModelID
        self.llmModelID = llmModelID
        self.activeTemplateID = activeTemplateID
        self.llmPolishEnabled = llmPolishEnabled
        self.autoInsert = autoInsert
        self.insertPosition = insertPosition
        self.hotwords = hotwords
        self.workingLanguages = workingLanguages
        self.outputLanguage = outputLanguage
        self.frontAppAware = frontAppAware
        self.injectionDefense = injectionDefense
        self.cleanOutput = cleanOutput
        self.feedbackSounds = feedbackSounds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Settings.defaults
        // Decode each array independently so one malformed collection can't wipe
        // the others (or reset the whole document to empty defaults).
        providers = (try? c.decode([Provider].self, forKey: .providers)) ?? d.providers
        models = (try? c.decode([ModelConfig].self, forKey: .models)) ?? d.models
        templates = (try? c.decode([PromptTemplate].self, forKey: .templates)) ?? d.templates
        hotkey = try c.decodeIfPresent(String.self, forKey: .hotkey) ?? d.hotkey
        // Decode independently so a malformed shortcut array can't wipe the doc.
        shortcuts = (try? c.decode([ActionShortcut].self, forKey: .shortcuts)) ?? []
        asrModelID = try c.decodeIfPresent(String.self, forKey: .asrModelID)
        llmModelID = try c.decodeIfPresent(String.self, forKey: .llmModelID)
        imageModelID = try c.decodeIfPresent(String.self, forKey: .imageModelID)
        videoModelID = try c.decodeIfPresent(String.self, forKey: .videoModelID)
        captureModelID = try c.decodeIfPresent(String.self, forKey: .captureModelID)
        mcpServers = (try? c.decode([MCPServerConfig].self, forKey: .mcpServers)) ?? []
        // Absent in older configs → seed the starter agents so the feature isn't
        // empty on first upgrade. An explicit `[]` (user deleted them all) stays.
        agents = (try? c.decode([Agent].self, forKey: .agents)) ?? Agent.seeded
        activeAgentID = try c.decodeIfPresent(String.self, forKey: .activeAgentID) ?? agents.first?.id
        toolRootDirectories = (try? c.decode([String].self, forKey: .toolRootDirectories)) ?? []
        activeTemplateID = try c.decodeIfPresent(String.self, forKey: .activeTemplateID)
        llmPolishEnabled = try c.decodeIfPresent(Bool.self, forKey: .llmPolishEnabled) ?? d.llmPolishEnabled
        autoInsert = try c.decodeIfPresent(Bool.self, forKey: .autoInsert) ?? d.autoInsert
        insertPosition = try c.decodeIfPresent(String.self, forKey: .insertPosition) ?? d.insertPosition
        hotwords = try c.decodeIfPresent([String].self, forKey: .hotwords) ?? d.hotwords
        workingLanguages = try c.decodeIfPresent([String].self, forKey: .workingLanguages) ?? d.workingLanguages
        outputLanguage = try c.decodeIfPresent(OutputLanguage.self, forKey: .outputLanguage) ?? d.outputLanguage
        frontAppAware = try c.decodeIfPresent(Bool.self, forKey: .frontAppAware) ?? d.frontAppAware
        injectionDefense = try c.decodeIfPresent(Bool.self, forKey: .injectionDefense) ?? d.injectionDefense
        cleanOutput = try c.decodeIfPresent(Bool.self, forKey: .cleanOutput) ?? d.cleanOutput
        feedbackSounds = (try? c.decode(FeedbackSoundSettings.self, forKey: .feedbackSounds)) ?? d.feedbackSounds
        capture = (try? c.decode(CaptureSettings.self, forKey: .capture)) ?? .defaults
        // A hotkey must be a numeric keycode; migrate anything else to right ⌘.
        if Int(hotkey) == nil { hotkey = d.hotkey }
    }

    // MARK: Lookups

    func provider(id: String) -> Provider? { providers.first { $0.id == id } }

    // MARK: Channel adapters (metadata / pricing / display)

    /// The channel adapter a provider is an instance of.
    func adapter(for provider: Provider) -> ChannelAdapter? {
        ChannelAdapter.byID(provider.adapterID)
    }

    func adapter(for model: ModelConfig) -> ChannelAdapter? {
        provider(id: model.providerID).flatMap(adapter(for:))
    }

    /// The adapter catalog card for a model, matched by its raw model id.
    func card(for model: ModelConfig) -> ModelCard? {
        adapter(for: model)?.card(forModelID: model.model)
    }

    /// Effective price: the user's per-model override wins; otherwise the
    /// adapter catalog's card price; otherwise nil (unknown / unpriced).
    func effectivePricing(of model: ModelConfig) -> ModelPricing? {
        if let o = model.pricingOverride, !o.isEmpty { return o }
        return card(for: model)?.pricing
    }

    /// `渠道商/模型ID` — the uniform label for selecting/disambiguating models.
    /// The channel is the provider's name (which defaults to the adapter's
    /// display name), so two providers of the same vendor stay distinguishable.
    func displayLabel(for model: ModelConfig) -> String {
        let channel = provider(id: model.providerID)?.name ?? "?"
        return "\(channel)/\(model.model)"
    }

    /// Build a cost-stamped `UsageRecord` for a completed call. Cost is computed
    /// now from the model's effective pricing so history stays stable later.
    func usageRecord(for model: ModelConfig, source: String, date: Date,
                     usage: TokenUsage? = nil, audioSeconds: Double? = nil) -> UsageRecord {
        let pricing = effectivePricing(of: model)
        let cost = pricing?.cost(inputTokens: usage?.input, outputTokens: usage?.output,
                                 cachedInputTokens: usage?.cachedInput, audioSeconds: audioSeconds)
        return UsageRecord(
            date: date,
            providerID: model.providerID,
            adapterID: provider(id: model.providerID)?.adapterID ?? ChannelAdapter.customID,
            modelID: model.model,
            label: displayLabel(for: model),
            capability: capability(of: model) ?? .chat,
            inputTokens: usage?.input,
            outputTokens: usage?.output,
            cachedInputTokens: usage?.cachedInput,
            audioSeconds: audioSeconds,
            cost: cost,
            currency: pricing?.currency,
            source: source)
    }

    var chatModels: [ModelConfig] {
        models.filter { capability(of: $0) == .chat }
    }

    var asrModels: [ModelConfig] {
        models.filter { capability(of: $0) == .asr }
    }

    var imageModels: [ModelConfig] {
        models.filter { capability(of: $0) == .image }
    }

    var videoModels: [ModelConfig] {
        models.filter { capability(of: $0) == .video }
    }

    var imageModel: ModelConfig? {
        guard let id = imageModelID,
              let model = models.first(where: { $0.id == id }),
              capability(of: model) == .image else { return nil }
        return model
    }

    var videoModel: ModelConfig? {
        guard let id = videoModelID,
              let model = models.first(where: { $0.id == id }),
              capability(of: model) == .video else { return nil }
        return model
    }

    var asrModel: ModelConfig? {
        guard let id = asrModelID,
              let model = models.first(where: { $0.id == id }),
              capability(of: model) == .asr else { return nil }
        return model
    }

    var llmModel: ModelConfig? {
        guard let id = llmModelID,
              let model = models.first(where: { $0.id == id }),
              capability(of: model) == .chat else { return nil }
        return model
    }

    /// The chat model the 截图 AI 标注 uses: an explicit `captureModelID` (must be
    /// a valid chat model) if set, otherwise the shared `llmModel`.
    var captureAnnotationModel: ModelConfig? {
        if let id = captureModelID,
           let model = models.first(where: { $0.id == id }),
           capability(of: model) == .chat {
            return model
        }
        return llmModel
    }

    var activeTemplate: PromptTemplate? {
        guard let id = activeTemplateID else { return nil }
        return templates.first { $0.id == id }
    }

    /// The active chat agent (falls back to the first one so chat always has a
    /// persona once any agent exists).
    var activeAgent: Agent? {
        if let id = activeAgentID, let a = agents.first(where: { $0.id == id }) { return a }
        return agents.first
    }

    /// The service a model speaks through, if it can be resolved. Falls back to
    /// the first service matching the model's legacy role (defensive — `migrate`
    /// normally backfills `serviceID` first).
    func service(for model: ModelConfig) -> Service? {
        guard let p = provider(id: model.providerID) else { return nil }
        if let id = model.serviceID, let s = p.services.first(where: { $0.id == id }) {
            return s
        }
        let cap = model.legacyKind?.capability ?? .chat
        return p.services.first { $0.capability == cap }
    }

    /// A model's capability, derived from its service.
    func capability(of model: ModelConfig) -> Capability? {
        service(for: model)?.capability ?? model.legacyKind?.capability
    }

    /// Resolve a model + its provider's credentials + its service into a
    /// call-ready bundle.
    func resolve(_ model: ModelConfig) -> ResolvedModel? {
        guard let p = provider(id: model.providerID),
              let s = service(for: model) else { return nil }
        return ResolvedModel(
            baseURL: p.baseURL,
            apiKey: p.apiKey,
            auth: p.auth,
            capability: s.capability,
            wire: s.wire,
            endpointPath: s.endpointPath,
            model: model.model,
            language: model.language,
            params: model.params ?? [:]
        )
    }
}

/// Resolved credentials + service + model id ready for an API call.
struct ResolvedModel {
    let baseURL: String
    let apiKey: String
    let auth: AuthScheme
    let capability: Capability
    let wire: Wire
    let endpointPath: String
    let model: String
    let language: String?
    let params: [String: String]

    /// The full endpoint this model's request goes to.
    var url: URL? {
        URL(string: baseURL.trimmed.trimmingTrailingSlash + endpointPath)
    }

    /// Apply auth + protocol headers to a request.
    func authorize(_ req: inout URLRequest) {
        auth.authorize(&req, apiKey: apiKey)
        wire.applyProtocolHeaders(&req)
    }
}
