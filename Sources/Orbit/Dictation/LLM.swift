//  LLM.swift
//  Optional polish step. After ASR, the recognized text is injected into the
//  active prompt template and sent to an OpenAI-compatible chat model, which
//  rewrites it. Toggleable — never mandatory.

import Foundation

enum LLM {

    /// Substitute the transcript into the template. `placeholder` is the name
    /// inside `{{…}}`; if absent, the transcript is appended after the template.
    static func render(template: String, placeholder: String, transcript: String) -> String {
        let token = "{{\(placeholder)}}"
        if template.contains(token) {
            return template.replacingOccurrences(of: token, with: transcript)
        }
        return "\(template)\n\n\(transcript)"
    }

    /// Streaming polish from an already-composed `(system, user)` pair (see
    /// `PromptComposer`). Deltas are delivered as they arrive; the full text is
    /// returned at the end.
    static func polishStreamMessages(_ model: ResolvedModel,
                                     system: String,
                                     user: String,
                                     onDelta: @MainActor @escaping (String) -> Void) async throws -> (text: String, usage: TokenUsage) {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选大模型服务商缺少 API Key。")
        }
        var messages: [ChatMessage] = []
        if !system.trimmed.isEmpty { messages.append(ChatMessage(role: .system, content: system)) }
        messages.append(ChatMessage(role: .user, content: user))

        var full = ""
        let outcome = try await ChatClient.stream(model: model, messages: messages) { piece in
            full += piece
            onDelta(piece)
        }
        return (full.trimmed, outcome.usage)
    }

    /// Streaming polish: same prompt as `polish`, but deltas are delivered to
    /// `onDelta` as they arrive (so the pill can render the text being written)
    /// and the full result is returned at the end.
    static func polishStream(_ model: ResolvedModel,
                             template: String,
                             placeholder: String,
                             transcript: String,
                             onDelta: @MainActor @escaping (String) -> Void) async throws -> String {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选大模型服务商缺少 API Key。")
        }
        let content = render(template: template, placeholder: placeholder, transcript: transcript)
        let messages = [ChatMessage(role: .user, content: content)]

        var full = ""
        try await ChatClient.stream(model: model, messages: messages) { piece in
            full += piece
            onDelta(piece)
        }
        return full.trimmed
    }

    static func polish(_ model: ResolvedModel,
                       template: String,
                       placeholder: String,
                       transcript: String) async throws -> String {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选大模型服务商缺少 API Key。")
        }
        guard let url = model.url else {
            throw OrbitError("大模型 Base URL 无效。")
        }
        let content = render(template: template, placeholder: placeholder, transcript: transcript)
        let messages = [ChatMessage(role: .user, content: content)]

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        model.authorize(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject:
            ChatClient.payload(model: model, messages: messages, stream: false, temperature: 0.3))

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw OrbitError(APIErrorHint.network(context: "润色", error))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            throw OrbitError(APIErrorHint.message(context: "润色", status: code, body: data))
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return extractText(json, wire: model.wire).trimmed
    }

    /// Pull the assistant text out of a non-streaming response per wire format.
    private static func extractText(_ json: [String: Any], wire: Wire) -> String {
        switch wire {
        case .openAIResponses:
            if let direct = json["output_text"] as? String { return direct }
            // Otherwise concatenate the `output_text` blocks inside `output[]`.
            let output = json["output"] as? [[String: Any]] ?? []
            return output.flatMap { ($0["content"] as? [[String: Any]]) ?? [] }
                .filter { ($0["type"] as? String) == "output_text" }
                .compactMap { $0["text"] as? String }
                .joined()
        case .anthropicMessages:
            let blocks = json["content"] as? [[String: Any]] ?? []
            return blocks.filter { ($0["type"] as? String) == "text" }
                .compactMap { $0["text"] as? String }
                .joined()
        default:
            // openAIChat + any custom chat wire.
            let choices = json["choices"] as? [[String: Any]]
            let message = choices?.first?["message"] as? [String: Any]
            return (message?["content"] as? String) ?? ""
        }
    }
}
