//  ChatClient.swift
//  Streaming chat against a provider, branching on its wire protocol:
//  OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. All three
//  speak Server-Sent Events (`data: {json}` lines); only the request body and
//  the per-chunk shape differ.

import Foundation

enum ChatClient {

    /// Stream a reply, delivering each content delta to `onDelta` on the main
    /// actor. Returns the token usage reported by the provider (empty if none).
    /// Throws on bad config / non-200 / transport error.
    @discardableResult
    static func stream(
        model: ResolvedModel,
        messages: [ChatMessage],
        onDelta: @MainActor @escaping (String) -> Void
    ) async throws -> TokenUsage {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选大模型服务商缺少 API Key。")
        }
        let req = try buildRequest(model: model, messages: messages, stream: true)

        let (bytes, resp) = try await URLSession.shared.bytes(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            var body = ""
            for try await line in bytes.lines {
                body += line
                if body.count > 600 { break }
            }
            throw OrbitError("大模型请求失败（\(code)）：\(body.prefix(300))")
        }

        // Each SSE event is a `data: {json}` line. Blank / keep-alive / `event:`
        // lines and malformed chunks are skipped. Usage arrives in a trailing
        // chunk (OpenAI, with stream_options) or across message_start/_delta
        // (Anthropic), so we accumulate it as we go.
        var usage = TokenUsage()
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let chunk = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if chunk.isEmpty { continue }
            if chunk == "[DONE]" { break }
            guard let data = chunk.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }

            switch try parse(json, wire: model.wire) {
            case .delta(let piece): if !piece.isEmpty { await onDelta(piece) }
            case .usage(let u): usage.merge(u)
            case .done(let u): if let u { usage.merge(u) }; return usage
            case .ignore: continue
            }
        }
        return usage
    }

    // MARK: - Request building

    static func buildRequest(model: ResolvedModel, messages: [ChatMessage], stream: Bool) throws -> URLRequest {
        guard let url = model.url else {
            throw OrbitError("大模型 Base URL 无效。")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        model.authorize(&req)
        req.httpBody = try JSONSerialization.data(
            withJSONObject: payload(model: model, messages: messages, stream: stream, temperature: 0.7)
        )
        return req
    }

    /// Build the wire-specific request body.
    static func payload(model: ResolvedModel, messages: [ChatMessage],
                        stream: Bool, temperature: Double) -> [String: Any] {
        switch model.wire {
        case .openAIChat:
            var p: [String: Any] = [
                "model": model.model,
                "messages": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
                "stream": stream,
                "temperature": temperature,
            ]
            // Ask OpenAI-compatible servers to emit a final usage chunk.
            if stream { p["stream_options"] = ["include_usage": true] }
            return p
        case .openAIResponses:
            var p: [String: Any] = [
                "model": model.model,
                "input": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
                "temperature": temperature,
            ]
            if stream { p["stream"] = true }
            return p
        case .anthropicMessages:
            // Anthropic carries the prompt's system text as a top-level field;
            // `messages` holds only the user / assistant turns.
            let system = messages.filter { $0.role == .system }
                .map(\.content).joined(separator: "\n\n")
            let turns = messages.filter { $0.role != .system }
                .map { ["role": $0.role.rawValue, "content": $0.content] }
            var p: [String: Any] = [
                "model": model.model,
                "messages": turns,
                "max_tokens": 4096,
                "temperature": temperature,
            ]
            if stream { p["stream"] = true }
            if !system.isEmpty { p["system"] = system }
            return p

        default:
            // Non-chat wires (embeddings / image / …) don't run through here;
            // fall back to the Chat Completions shape for any custom chat wire.
            var p: [String: Any] = [
                "model": model.model,
                "messages": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
                "stream": stream,
                "temperature": temperature,
            ]
            if stream { p["stream_options"] = ["include_usage": true] }
            return p
        }
    }

    // MARK: - Stream parsing

    private enum Event { case delta(String), usage(TokenUsage), done(TokenUsage?), ignore }

    private static func parse(_ json: [String: Any], wire: Wire) throws -> Event {
        // A top-level `error` object can arrive mid-stream on any protocol
        // (the server opened with 200 then failed). Surface it uniformly.
        if let err = json["error"] as? [String: Any] {
            throw OrbitError("大模型返回错误：\((err["message"] as? String) ?? "未知错误")")
        }
        switch wire {
        case .openAIResponses:
            switch json["type"] as? String {
            case "response.output_text.delta":
                return .delta((json["delta"] as? String) ?? "")
            case "response.completed":
                let u = (json["response"] as? [String: Any])?["usage"] as? [String: Any]
                return .done(u.map(responsesUsage))
            case "response.failed", "response.incomplete":
                let e = (json["response"] as? [String: Any])?["error"] as? [String: Any]
                throw OrbitError("大模型返回错误：\((e?["message"] as? String) ?? "未知错误")")
            default:
                return .ignore
            }

        case .anthropicMessages:
            switch json["type"] as? String {
            case "message_start":
                let u = (json["message"] as? [String: Any])?["usage"] as? [String: Any]
                return u.map { .usage(anthropicInputUsage($0)) } ?? .ignore
            case "content_block_delta":
                let delta = json["delta"] as? [String: Any]
                return .delta((delta?["text"] as? String) ?? "")
            case "message_delta":
                let u = json["usage"] as? [String: Any]
                return u.map { .usage(TokenUsage(output: $0["output_tokens"] as? Int)) } ?? .ignore
            case "message_stop":
                return .done(nil)
            default:
                return .ignore
            }

        default:
            // openAIChat + any custom chat wire. The trailing usage chunk (from
            // stream_options.include_usage) has usage set and empty choices.
            if let u = json["usage"] as? [String: Any] {
                return .usage(openAIUsage(u))
            }
            guard let choices = json["choices"] as? [[String: Any]],
                  let delta = choices.first?["delta"] as? [String: Any],
                  let piece = delta["content"] as? String
            else { return .ignore }
            return .delta(piece)
        }
    }

    // MARK: - Usage parsing

    private static func openAIUsage(_ u: [String: Any]) -> TokenUsage {
        let cached = (u["prompt_tokens_details"] as? [String: Any])?["cached_tokens"] as? Int
        return TokenUsage(input: u["prompt_tokens"] as? Int,
                          output: u["completion_tokens"] as? Int,
                          cachedInput: cached)
    }

    private static func responsesUsage(_ u: [String: Any]) -> TokenUsage {
        let cached = (u["input_tokens_details"] as? [String: Any])?["cached_tokens"] as? Int
        return TokenUsage(input: u["input_tokens"] as? Int,
                          output: u["output_tokens"] as? Int,
                          cachedInput: cached)
    }

    private static func anthropicInputUsage(_ u: [String: Any]) -> TokenUsage {
        TokenUsage(input: u["input_tokens"] as? Int,
                   output: u["output_tokens"] as? Int,
                   cachedInput: u["cache_read_input_tokens"] as? Int)
    }
}
