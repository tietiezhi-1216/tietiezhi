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

    var id: String { rawValue }

    /// The capability (function) this protocol implements.
    var capability: Capability {
        switch self {
        case .openAIChat, .openAIResponses, .anthropicMessages: return .chat
        case .openAITranscription, .mimoAudioASR:               return .asr
        }
    }

    var displayName: String {
        switch self {
        case .openAIChat:          return "OpenAI Chat Completions"
        case .openAIResponses:     return "OpenAI Responses"
        case .anthropicMessages:   return "Anthropic Messages"
        case .openAITranscription: return "OpenAI Transcription"
        case .mimoAudioASR:        return "MiMo 音频识别（Chat）"
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

    init(id: String = UUID().uuidString,
         name: String,
         baseURL: String = Provider.openAIBase,
         apiKey: String = "",
         auth: AuthScheme = .bearer,
         services: [Service]? = nil) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.auth = auth
        self.services = services ?? Service.seedCatalog(legacyAPI: nil)
    }

    static let openAIBase = "https://api.openai.com/v1"

    private enum CodingKeys: String, CodingKey {
        case id, name, baseURL, apiKey, auth, services
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

    /// Transient: the role read from a legacy config, used by `migrate` to pick
    /// a service. Never persisted.
    var legacyKind: ModelKind?

    init(id: String = UUID().uuidString,
         providerID: String,
         serviceID: String?,
         name: String,
         model: String,
         language: String? = nil,
         params: [String: String]? = nil) {
        self.id = id
        self.providerID = providerID
        self.serviceID = serviceID
        self.name = name
        self.model = model
        self.language = language
        self.params = params
        self.legacyKind = nil
    }

    private enum CodingKeys: String, CodingKey {
        case id, providerID, serviceID, name, model, language, params
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
    var asrModelID: String?
    var llmModelID: String?
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
            insertPosition: "transcript"
        )
    }

    init(providers: [Provider], models: [ModelConfig], templates: [PromptTemplate],
         hotkey: String, asrModelID: String?, llmModelID: String?,
         activeTemplateID: String?, llmPolishEnabled: Bool, autoInsert: Bool,
         insertPosition: String,
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
        asrModelID = try c.decodeIfPresent(String.self, forKey: .asrModelID)
        llmModelID = try c.decodeIfPresent(String.self, forKey: .llmModelID)
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
        // A hotkey must be a numeric keycode; migrate anything else to right ⌘.
        if Int(hotkey) == nil { hotkey = d.hotkey }
    }

    // MARK: Lookups

    func provider(id: String) -> Provider? { providers.first { $0.id == id } }

    var asrModel: ModelConfig? {
        guard let id = asrModelID else { return nil }
        return models.first { $0.id == id }
    }

    var llmModel: ModelConfig? {
        guard let id = llmModelID else { return nil }
        return models.first { $0.id == id }
    }

    var activeTemplate: PromptTemplate? {
        guard let id = activeTemplateID else { return nil }
        return templates.first { $0.id == id }
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
