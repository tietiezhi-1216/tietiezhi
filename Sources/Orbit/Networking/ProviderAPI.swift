//  ProviderAPI.swift
//  Lightweight provider probes used by the Settings UI: validate a base URL +
//  key ("Test"), and list the model ids a provider exposes ("Fetch list").

import Foundation

enum ProviderAPIError: LocalizedError {
    case http(Int, String)
    case badURL
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .http(let code, let body):
            return "HTTP \(code)\(body.isEmpty ? "" : "：\(body.prefix(200))")"
        case .badURL: return "Base URL 无效"
        case .transport(let m): return m
        }
    }
}

enum ProviderAPI {

    /// Validate base URL + API key by probing the list-models endpoint. Many
    /// providers expose `/models`; some (e.g. MiMo) don't — so a missing
    /// endpoint is reported as "couldn't auto-verify" rather than a hard failure,
    /// and an auth rejection nudges toward the right scheme.
    static func test(_ provider: Provider) async throws -> String {
        let (status, body) = try await getModels(provider)
        switch status {
        case 200:
            return "连接正常"
        case 404:
            return "凭证已设置。该服务商未提供 /models 列表接口，无法自动校验——请直接在「模型」里填模型 id 并实际调用验证。"
        case 401, 403:
            let detail = (String(data: body, encoding: .utf8) ?? "").trimmed.prefix(160)
            throw ProviderAPIError.transport(
                "鉴权失败（HTTP \(status)）：请检查 API Key 是否正确、是否与所选渠道商匹配。\(detail)")
        default:
            throw ProviderAPIError.http(status, String(data: body, encoding: .utf8) ?? "")
        }
    }

    /// One model as reported by `GET /models`: its id, an optional friendly name
    /// (`display_name`, when the relay includes one), and any capability flags the
    /// upstream actually declares (`nil` when it says nothing — most plain
    /// OpenAI-shaped relays). Feature flags are read, never guessed from the id.
    struct FetchedModel {
        let id: String
        let displayName: String?
        let abilities: LLMCapabilities?
    }

    /// List the models the provider exposes. Both the OpenAI `GET /models` and
    /// Anthropic `GET /v1/models` responses share a `{ data: [{ id }] }` shape, so
    /// one parser covers all schemes; richer per-model fields are parsed when present.
    static func fetchModels(_ provider: Provider) async throws -> [FetchedModel] {
        let (status, body) = try await getModels(provider)
        guard status == 200 else {
            throw ProviderAPIError.http(status, String(data: body, encoding: .utf8) ?? "")
        }
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        let data = json?["data"] as? [[String: Any]] ?? []
        let models = data.compactMap { m -> FetchedModel? in
            guard let id = m["id"] as? String else { return nil }
            let name = (m["display_name"] as? String) ?? (m["name"] as? String)
            return FetchedModel(id: id, displayName: name?.trimmed.isEmpty == false ? name : nil,
                                abilities: parseAbilities(m))
        }
        return models.sorted { $0.id < $1.id }
    }

    /// Map a model object's *declared* capability fields to `LLMCapabilities`.
    /// Returns nil when the upstream exposes none (→ the user sets them by hand).
    /// Reads OpenRouter's `architecture` / `supported_parameters` plus a handful of
    /// boolean fields some relays add. Absence never implies false — it implies
    /// "unknown", which is why the whole thing is optional.
    private static func parseAbilities(_ m: [String: Any]) -> LLMCapabilities? {
        var multimodal: Bool?
        var thinking: Bool?
        var tools: Bool?

        if let arch = m["architecture"] as? [String: Any] {
            if let mods = arch["input_modalities"] as? [String] {
                multimodal = mods.contains { $0.lowercased() != "text" }
            } else if let modality = arch["modality"] as? String {
                let l = modality.lowercased()
                multimodal = l.contains("image") || l.contains("audio") || l.contains("video")
            }
        }
        if let params = m["supported_parameters"] as? [String] {
            let set = Set(params.map { $0.lowercased() })
            tools = set.contains("tools") || set.contains("tool_choice") || set.contains("functions")
            thinking = set.contains("reasoning") || set.contains("include_reasoning")
        }
        // Generic booleans some relays expose — read only if present.
        func flag(_ keys: [String]) -> Bool? {
            for k in keys { if let v = m[k] as? Bool { return v } }
            return nil
        }
        multimodal = multimodal ?? flag(["multimodal", "vision", "supports_vision", "support_vision"])
        thinking   = thinking   ?? flag(["reasoning", "thinking", "supports_reasoning", "support_reasoning"])
        tools      = tools      ?? flag(["tools", "function_calling", "supports_tools", "support_function_call"])

        if multimodal == nil && thinking == nil && tools == nil { return nil }
        return LLMCapabilities(multimodal: multimodal ?? false,
                               thinking: thinking ?? false,
                               toolCalling: tools ?? false)
    }

    // MARK: - Reasoning-effort probe

    /// Outcome of probing which reasoning-effort tiers a model accepts.
    enum ReasoningProbe {
        case detected([String])   // server validates the param; these passed
        case cannotDetect         // server ignores unknown efforts — can't tell
        case failed(String)       // auth / network error
    }

    /// Detect the reasoning-effort levels a chat model supports. A canary with a
    /// bogus effort first: if the server accepts it (200) it doesn't validate the
    /// param and we can't detect (→ user sets levels by hand). If rejected (400),
    /// each candidate is probed — the candidate set is the built-in list plus any
    /// levels the canary's error message advertised (`Supported values are: …`),
    /// so model-specific extras like `max` / `ultra` are found automatically.
    static func probeReasoning(_ model: ResolvedModel) async -> ReasoningProbe {
        // Only the OpenAI-shaped wires carry `reasoning_effort` / `reasoning.effort`.
        guard model.wire == .openAIChat || model.wire == .openAIResponses else {
            return .cannotDetect
        }
        let (canaryCode, canaryBody) = await probeStatus(model, effort: "__orbit_canary__")
        switch canaryCode {
        case 200:        return .cannotDetect
        case 401, 403:   return .failed("鉴权失败，无法探测。")
        case 0:          return .failed("网络错误，无法探测。")
        default:         break   // 400/422 → validates → probe each candidate
        }
        // Seed the candidate set from the built-in list + whatever the error body
        // advertised, minus obvious non-levels.
        var candidates = ReasoningLevels.candidates
        for tok in quotedTokens(in: canaryBody) where !candidates.contains(tok) { candidates.append(tok) }
        candidates.removeAll { $0 == "none" || $0.isEmpty || $0.hasPrefix("__orbit") }

        var supported: [String] = []
        for level in candidates {
            if await probeStatus(model, effort: level).0 == 200 { supported.append(level) }
        }
        return .detected(ReasoningLevels.sorted(supported))
    }

    /// POST a minimal completion with the given effort; return (status, body).
    private static func probeStatus(_ model: ResolvedModel, effort: String) async -> (Int, String) {
        guard let url = model.url else { return (0, "") }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        model.authorize(&req)
        let body: [String: Any]
        if model.wire == .openAIResponses {
            body = ["model": model.model, "input": "hi", "reasoning": ["effort": effort]]
        } else {
            body = ["model": model.model,
                    "messages": [["role": "user", "content": "hi"]],
                    "reasoning_effort": effort]
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, resp) = try? await URLSession.shared.data(for: req) else { return (0, "") }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (code, String(data: data, encoding: .utf8) ?? "")
    }

    /// Extract lowercase `'token'`-quoted identifiers from an error body — used to
    /// harvest the effort levels a server advertises in its rejection message.
    private static func quotedTokens(in s: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: "'([A-Za-z][A-Za-z0-9_-]*)'") else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).compactMap {
            $0.numberOfRanges > 1 ? ns.substring(with: $0.range(at: 1)).lowercased() : nil
        }
    }

    // MARK: - Internal

    private static func getModels(_ provider: Provider) async throws -> (Int, Data) {
        guard let url = provider.modelsEndpoint else { throw ProviderAPIError.badURL }
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        provider.auth.authorize(&req, apiKey: provider.apiKey)
        // Anthropic's GET /v1/models also requires the API-version header.
        if provider.auth == .anthropic {
            req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        }
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            return (code, data)
        } catch {
            throw ProviderAPIError.transport(error.localizedDescription)
        }
    }
}

// MARK: - Small string helpers shared across networking code

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmingTrailingSlash: String {
        var s = self
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
