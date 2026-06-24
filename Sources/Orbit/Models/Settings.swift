//  Settings.swift
//  Typed configuration model. Describes which providers exist (OpenAI-compatible
//  endpoints), which models they expose, and how each model is reached.
//  Persisted as JSON by `SettingsStore`. Decoding is tolerant of older configs
//  (e.g. the dropped 火山引擎 fields are simply ignored).

import Foundation

// MARK: - Enums

/// What a model is used for.
enum ModelKind: String, Codable, Hashable, CaseIterable {
    case asr  // speech → text
    case llm  // text (chat / polish)
}

/// How an ASR model uploads audio. Only HTTP today (buffer the utterance, upload
/// once). Kept as an enum so streaming transports can be added back later.
enum Transport: String, Codable, Hashable {
    case http
}

// MARK: - Provider

/// A model vendor / endpoint — an OpenAI-compatible base URL + API key.
struct Provider: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    /// OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`.
    var baseURL: String
    var apiKey: String

    init(id: String = UUID().uuidString,
         name: String,
         baseURL: String = Provider.openAIBase,
         apiKey: String = "") {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.apiKey = apiKey
    }

    static let openAIBase = "https://api.openai.com/v1"

    private enum CodingKeys: String, CodingKey { case id, name, baseURL, apiKey }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Provider"
        baseURL = try c.decodeIfPresent(String.self, forKey: .baseURL) ?? Provider.openAIBase
        apiKey = try c.decodeIfPresent(String.self, forKey: .apiKey) ?? ""
        // Older configs may carry kind/appID/resourceID — ignored.
    }
}

// MARK: - Model

/// A concrete model belonging to a provider.
struct ModelConfig: Identifiable, Codable, Hashable {
    var id: String
    var providerID: String
    /// Human-facing label.
    var name: String
    /// The provider's model identifier, e.g. `gpt-4o-transcribe`, `gpt-4o-mini`.
    var model: String
    var kind: ModelKind
    var transport: Transport
    /// Optional BCP-47-ish language hint, e.g. `zh` / `en`.
    var language: String?

    init(id: String = UUID().uuidString,
         providerID: String,
         name: String,
         model: String,
         kind: ModelKind,
         transport: Transport = .http,
         language: String? = nil) {
        self.id = id
        self.providerID = providerID
        self.name = name
        self.model = model
        self.kind = kind
        self.transport = transport
        self.language = language
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        providerID = try c.decodeIfPresent(String.self, forKey: .providerID) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Model"
        model = try c.decodeIfPresent(String.self, forKey: .model) ?? ""
        kind = (try? c.decode(ModelKind.self, forKey: .kind)) ?? .asr
        // Old transports (realtime_ws / volcano_ws) no longer exist → default http.
        transport = (try? c.decode(Transport.self, forKey: .transport)) ?? .http
        language = try c.decodeIfPresent(String.self, forKey: .language)
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

    static let defaultTemplateID = "default-polish"

    static var defaults: Settings {
        Settings(
            providers: [],
            models: [],
            templates: [
                PromptTemplate(
                    id: defaultTemplateID,
                    name: "默认润色",
                    template: "你是一个听写助手。请把下面的文本改写得通顺、标点正确、自然流畅，保持原意和原语言。只输出改写后的文本。\n\n{{transcript}}"
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
         insertPosition: String) {
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

    /// Resolve a model + its provider's credentials into a call-ready bundle.
    func resolve(_ model: ModelConfig) -> ResolvedModel? {
        guard let p = provider(id: model.providerID) else { return nil }
        return ResolvedModel(
            baseURL: p.baseURL,
            apiKey: p.apiKey,
            model: model.model,
            transport: model.transport,
            language: model.language
        )
    }
}

/// Resolved credentials + model id ready for an API call.
struct ResolvedModel {
    let baseURL: String
    let apiKey: String
    let model: String
    let transport: Transport
    let language: String?
}
