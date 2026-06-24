//  ChatClient.swift
//  Streaming chat completions against an OpenAI-compatible endpoint. Used by the
//  chat (Agent) surface. Dictation's LLM.polish stays separate and untouched.

import Foundation

enum ChatClient {

    /// Stream a chat completion, delivering each content delta to `onDelta` on
    /// the main actor. Throws on bad config / non-200 / transport error.
    static func stream(
        model: ResolvedModel,
        messages: [ChatMessage],
        onDelta: @MainActor @escaping (String) -> Void
    ) async throws {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选大模型服务商缺少 API Key。")
        }
        let base = model.baseURL.trimmingTrailingSlash
        guard let url = URL(string: base + "/chat/completions") else {
            throw OrbitError("大模型 Base URL 无效。")
        }

        let payload: [String: Any] = [
            "model": model.model,
            "messages": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
            "stream": true,
            "temperature": 0.7,
        ]
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("Bearer \(model.apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)

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

        // Server-Sent Events: each event is a `data: {json}` line, terminated by
        // `data: [DONE]`. Blank/keep-alive lines and malformed chunks are skipped.
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let chunk = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if chunk.isEmpty { continue }
            if chunk == "[DONE]" { break }
            guard let data = chunk.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            // Some providers open the stream with HTTP 200 then send an error
            // object mid-stream — surface it instead of ending silently empty.
            if let err = json["error"] as? [String: Any] {
                throw OrbitError("大模型返回错误：\((err["message"] as? String) ?? "未知错误")")
            }
            guard let choices = json["choices"] as? [[String: Any]],
                  let delta = choices.first?["delta"] as? [String: Any],
                  let piece = delta["content"] as? String,
                  !piece.isEmpty
            else { continue }
            await onDelta(piece)
        }
    }
}
