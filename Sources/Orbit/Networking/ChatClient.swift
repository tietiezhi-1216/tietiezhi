//  ChatClient.swift
//  Streaming chat against a provider, branching on its wire protocol:
//  OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. All three
//  speak Server-Sent Events (`data: {json}` lines); only the request body and
//  the per-chunk shape differ.

import Foundation

enum ChatClient {

    /// What a completed stream produced besides the text deltas: provider-reported
    /// usage and any tool invocations the model requested.
    struct StreamOutcome {
        var usage = TokenUsage()
        var toolCalls: [ToolCall] = []
    }

    /// Stream a reply, delivering each content delta to `onDelta` on the main
    /// actor. Pass `tools` to offer function calling (encoded per wire); any
    /// tool calls the model makes are accumulated from the stream fragments and
    /// returned in the outcome. Throws on bad config / non-200 / transport error.
    @discardableResult
    static func stream(
        model: ResolvedModel,
        messages: [ChatMessage],
        tools: [ToolSpec] = [],
        reasoning: String = "",
        onDelta: @MainActor @escaping (String) -> Void
    ) async throws -> StreamOutcome {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选大模型服务商缺少 API Key。")
        }
        let req = try buildRequest(model: model, messages: messages, tools: tools,
                                   reasoning: reasoning, stream: true)

        let (bytes, resp): (URLSession.AsyncBytes, URLResponse)
        do {
            (bytes, resp) = try await URLSession.shared.bytes(for: req)
        } catch {
            throw OrbitError(APIErrorHint.network(context: "大模型", error))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            var body = ""
            for try await line in bytes.lines {
                body += line
                if body.count > 600 { break }
            }
            throw OrbitError(APIErrorHint.message(context: "大模型", status: code, body: Data(body.utf8)))
        }

        // Each SSE event is a `data: {json}` line. Blank / keep-alive / `event:`
        // lines and malformed chunks are skipped. Usage arrives in a trailing
        // chunk (OpenAI, with stream_options) or across message_start/_delta
        // (Anthropic). Tool calls arrive as fragments — OpenAI streams the id +
        // name first and the JSON arguments in pieces keyed by `index`;
        // Anthropic opens a tool_use block then streams input_json_delta — so
        // both are accumulated in an index-keyed builder and finalized at end.
        var outcome = StreamOutcome()
        var toolBuilders: [Int: (id: String, name: String, args: String)] = [:]

        func finish() -> StreamOutcome {
            outcome.toolCalls = toolBuilders.sorted { $0.key < $1.key }.map {
                ToolCall(id: $0.value.id, name: $0.value.name,
                         argumentsJSON: $0.value.args.isEmpty ? "{}" : $0.value.args)
            }
            return outcome
        }

        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let chunk = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if chunk.isEmpty { continue }
            if chunk == "[DONE]" { break }
            guard let data = chunk.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }

            for event in try parse(json, wire: model.wire) {
                switch event {
                case .delta(let piece):
                    if !piece.isEmpty { await onDelta(piece) }
                case .usage(let u):
                    outcome.usage.merge(u)
                case .toolFragment(let index, let id, let name, let args):
                    var b = toolBuilders[index] ?? (id: "", name: "", args: "")
                    if let id, !id.isEmpty { b.id = id }
                    if let name, !name.isEmpty { b.name = name }
                    b.args += args
                    toolBuilders[index] = b
                case .done(let u):
                    if let u { outcome.usage.merge(u) }
                    return finish()
                case .ignore:
                    continue
                }
            }
        }
        return finish()
    }

    // MARK: - Request building

    static func buildRequest(model: ResolvedModel, messages: [ChatMessage],
                             tools: [ToolSpec] = [], reasoning: String = "",
                             stream: Bool) throws -> URLRequest {
        guard let url = model.url else {
            throw OrbitError("大模型 Base URL 无效。")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        model.authorize(&req)
        req.httpBody = try JSONSerialization.data(
            withJSONObject: payload(model: model, messages: messages, tools: tools,
                                    reasoning: reasoning, stream: stream, temperature: 0.7)
        )
        return req
    }

    /// Build the wire-specific request body.
    static func payload(model: ResolvedModel, messages: [ChatMessage],
                        tools: [ToolSpec] = [], reasoning: String = "",
                        stream: Bool, temperature: Double) -> [String: Any] {
        switch model.wire {
        case .anthropicMessages:
            // Anthropic carries the prompt's system text as a top-level field;
            // `messages` holds only the user / assistant turns. Tool traffic is
            // structured content blocks, not a `tool` role.
            let system = messages.filter { $0.role == .system }
                .map(\.content).joined(separator: "\n\n")
            var p: [String: Any] = [
                "model": model.model,
                "messages": anthropicTurns(messages),
                // max_tokens must exceed the thinking budget.
                "max_tokens": reasoning.isEmpty ? 4096 : ReasoningLevels.anthropicBudget(reasoning) + 4096,
                // Anthropic requires temperature = 1 while extended thinking is on.
                "temperature": reasoning.isEmpty ? temperature : 1.0,
            ]
            if !reasoning.isEmpty {
                p["thinking"] = ["type": "enabled", "budget_tokens": ReasoningLevels.anthropicBudget(reasoning)]
            }
            if stream { p["stream"] = true }
            if !system.isEmpty { p["system"] = system }
            if !tools.isEmpty {
                p["tools"] = tools.map {
                    ["name": $0.name, "description": $0.description, "input_schema": $0.parameters]
                }
            }
            return p

        case .openAIResponses:
            // Tool loop not yet enabled on the Responses wire (different tool
            // item shapes); plain text conversation only.
            var p: [String: Any] = [
                "model": model.model,
                "input": messages.filter { $0.role != .tool }
                    .map { ["role": $0.role.rawValue, "content": $0.content] },
                "temperature": temperature,
            ]
            if !reasoning.isEmpty { p["reasoning"] = ["effort": reasoning] }
            if stream { p["stream"] = true }
            return p

        default:
            // openAIChat + any custom chat wire: the Chat Completions shape.
            var p: [String: Any] = [
                "model": model.model,
                "messages": messages.map(openAIMessage),
                "stream": stream,
                "temperature": temperature,
            ]
            // Ask OpenAI-compatible servers to emit a final usage chunk.
            if stream { p["stream_options"] = ["include_usage": true] }
            if !reasoning.isEmpty { p["reasoning_effort"] = reasoning }
            if !tools.isEmpty {
                p["tools"] = tools.map {
                    ["type": "function",
                     "function": ["name": $0.name, "description": $0.description,
                                  "parameters": $0.parameters]]
                }
            }
            return p
        }
    }

    // MARK: - Message encoding (tool round-trips)

    /// One message in OpenAI Chat Completions shape, including assistant
    /// tool_calls, `role:"tool"` results, and user image attachments (encoded as
    /// `image_url` data-URI parts for vision models).
    private static func openAIMessage(_ m: ChatMessage) -> [String: Any] {
        if m.role == .tool, let r = m.toolResult {
            return ["role": "tool", "tool_call_id": r.toolCallID, "content": r.content]
        }
        var msg: [String: Any] = ["role": m.role.rawValue]
        let images = userImageData(m)
        if images.isEmpty {
            msg["content"] = m.content
        } else {
            var parts: [[String: Any]] = []
            if !m.content.isEmpty { parts.append(["type": "text", "text": m.content]) }
            for (mime, b64) in images {
                parts.append(["type": "image_url", "image_url": ["url": "data:\(mime);base64,\(b64)"]])
            }
            msg["content"] = parts
        }
        if m.role == .assistant, let calls = m.toolCalls, !calls.isEmpty {
            msg["tool_calls"] = calls.map {
                ["id": $0.id, "type": "function",
                 "function": ["name": $0.name, "arguments": $0.argumentsJSON]]
            }
        }
        return msg
    }

    /// Base64-encoded (mime, data) for a user message's image attachments. Only
    /// user-provided images are sent as input; assistant/tool attachments are
    /// display-only. Non-image / unreadable files are skipped.
    private static func userImageData(_ m: ChatMessage) -> [(String, String)] {
        guard m.role == .user, let paths = m.attachments else { return [] }
        var out: [(String, String)] = []
        for path in paths {
            let url = URL(fileURLWithPath: path)
            let mime = imageMime(url.pathExtension)
            guard mime != nil, let data = try? Data(contentsOf: url) else { continue }
            out.append((mime!, data.base64EncodedString()))
        }
        return out
    }

    private static func imageMime(_ ext: String) -> String? {
        switch ext.lowercased() {
        case "png":          return "image/png"
        case "jpg", "jpeg":  return "image/jpeg"
        case "gif":          return "image/gif"
        case "webp":         return "image/webp"
        case "heic":         return "image/heic"
        default:             return nil
        }
    }

    /// Anthropic turns: assistant tool calls become `tool_use` content blocks;
    /// `.tool` messages become user `tool_result` blocks (consecutive results
    /// merge into one user turn, and each result must directly follow its
    /// tool_use round — which our loop's ordering guarantees).
    private static func anthropicTurns(_ messages: [ChatMessage]) -> [[String: Any]] {
        var turns: [[String: Any]] = []
        var pendingResults: [[String: Any]] = []

        func flushResults() {
            guard !pendingResults.isEmpty else { return }
            turns.append(["role": "user", "content": pendingResults])
            pendingResults = []
        }

        for m in messages where m.role != .system {
            if m.role == .tool, let r = m.toolResult {
                var block: [String: Any] = ["type": "tool_result", "tool_use_id": r.toolCallID,
                                            "content": r.content]
                if r.isError { block["is_error"] = true }
                pendingResults.append(block)
                continue
            }
            flushResults()
            if m.role == .assistant, let calls = m.toolCalls, !calls.isEmpty {
                var blocks: [[String: Any]] = []
                if !m.content.isEmpty { blocks.append(["type": "text", "text": m.content]) }
                for call in calls {
                    let input = (try? JSONSerialization.jsonObject(
                        with: Data(call.argumentsJSON.utf8))) as? [String: Any] ?? [:]
                    blocks.append(["type": "tool_use", "id": call.id, "name": call.name, "input": input])
                }
                turns.append(["role": "assistant", "content": blocks])
            } else {
                let images = userImageData(m)
                if images.isEmpty {
                    turns.append(["role": m.role.rawValue, "content": m.content])
                } else {
                    var blocks: [[String: Any]] = []
                    if !m.content.isEmpty { blocks.append(["type": "text", "text": m.content]) }
                    for (mime, b64) in images {
                        blocks.append(["type": "image",
                                       "source": ["type": "base64", "media_type": mime, "data": b64]])
                    }
                    turns.append(["role": "user", "content": blocks])
                }
            }
        }
        flushResults()
        return turns
    }

    // MARK: - Stream parsing

    private enum Event {
        case delta(String)
        case usage(TokenUsage)
        /// A piece of a streamed tool call, keyed by the wire's block/call index.
        case toolFragment(index: Int, id: String?, name: String?, args: String)
        case done(TokenUsage?)
        case ignore
    }

    private static func parse(_ json: [String: Any], wire: Wire) throws -> [Event] {
        // A top-level `error` object can arrive mid-stream on any protocol
        // (the server opened with 200 then failed). Surface it uniformly.
        if let err = json["error"] as? [String: Any] {
            throw OrbitError("大模型返回错误：\((err["message"] as? String) ?? "未知错误")")
        }
        switch wire {
        case .openAIResponses:
            switch json["type"] as? String {
            case "response.output_text.delta":
                return [.delta((json["delta"] as? String) ?? "")]
            case "response.completed":
                let u = (json["response"] as? [String: Any])?["usage"] as? [String: Any]
                return [.done(u.map(responsesUsage))]
            case "response.failed", "response.incomplete":
                let e = (json["response"] as? [String: Any])?["error"] as? [String: Any]
                throw OrbitError("大模型返回错误：\((e?["message"] as? String) ?? "未知错误")")
            default:
                return [.ignore]
            }

        case .anthropicMessages:
            switch json["type"] as? String {
            case "message_start":
                let u = (json["message"] as? [String: Any])?["usage"] as? [String: Any]
                return [u.map { .usage(anthropicInputUsage($0)) } ?? .ignore]
            case "content_block_start":
                // A tool_use block opening carries the call id + tool name; its
                // JSON input then streams via input_json_delta fragments.
                guard let index = json["index"] as? Int,
                      let block = json["content_block"] as? [String: Any],
                      (block["type"] as? String) == "tool_use"
                else { return [.ignore] }
                return [.toolFragment(index: index,
                                      id: block["id"] as? String,
                                      name: block["name"] as? String,
                                      args: "")]
            case "content_block_delta":
                guard let delta = json["delta"] as? [String: Any] else { return [.ignore] }
                if let text = delta["text"] as? String {
                    return [.delta(text)]
                }
                if (delta["type"] as? String) == "input_json_delta",
                   let partial = delta["partial_json"] as? String,
                   let index = json["index"] as? Int {
                    return [.toolFragment(index: index, id: nil, name: nil, args: partial)]
                }
                return [.ignore]
            case "message_delta":
                let u = json["usage"] as? [String: Any]
                return [u.map { .usage(TokenUsage(output: $0["output_tokens"] as? Int)) } ?? .ignore]
            case "message_stop":
                return [.done(nil)]
            default:
                return [.ignore]
            }

        default:
            // openAIChat + any custom chat wire. The trailing usage chunk (from
            // stream_options.include_usage) has usage set and empty choices.
            // Tool calls stream in `delta.tool_calls`: first fragment per index
            // has the id + function name, later ones only argument pieces.
            var events: [Event] = []
            if let u = json["usage"] as? [String: Any] {
                events.append(.usage(openAIUsage(u)))
            }
            if let choices = json["choices"] as? [[String: Any]],
               let delta = choices.first?["delta"] as? [String: Any] {
                if let piece = delta["content"] as? String {
                    events.append(.delta(piece))
                }
                for tc in delta["tool_calls"] as? [[String: Any]] ?? [] {
                    let fn = tc["function"] as? [String: Any]
                    events.append(.toolFragment(
                        index: tc["index"] as? Int ?? 0,
                        id: tc["id"] as? String,
                        name: fn?["name"] as? String,
                        args: fn?["arguments"] as? String ?? ""))
                }
            }
            return events.isEmpty ? [.ignore] : events
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
