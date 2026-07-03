//  Transcriber.swift
//  Speech → text. ASR is multi-protocol — the model's `wire` decides the shape:
//   • openAITranscription — OpenAI Whisper-style `POST /audio/transcriptions`
//     (multipart upload, returns `{ text }`).
//   • mimoAudioASR        — MiMo-style audio over `POST /chat/completions`
//     (the WAV goes in as a Base64 `input_audio` content part + `asr_options`).
//  Plus an in-memory WAV encoder for the recorded PCM.

import Foundation

enum Transcriber {
    /// Keep every request below common 10 MB audio/body limits. 7 MB WAV leaves
    /// headroom for Base64 inflation in chat-style audio APIs.
    private static let maxChunkWAVBytes = 7_000_000

    /// Transcribe a recorded WAV, dispatching on the model's ASR protocol.
    static func transcribe(_ model: ResolvedModel, wav: Data) async throws -> String {
        switch model.wire {
        case .mimoAudioASR: return try await chatAudio(model, wav: wav)
        default:            return try await http(model, wav: wav) // Whisper multipart
        }
    }

    /// Transcribe PCM samples. Long recordings are split into multiple WAV
    /// requests so providers with 10 MB request/file limits don't reject them.
    static func transcribe(_ model: ResolvedModel,
                           samples: [Int16],
                           rate: Int,
                           onChunk: ((Int, Int) async -> Void)? = nil) async throws -> String {
        let chunks = sampleChunks(samples)
        guard chunks.count > 1 else {
            await onChunk?(1, 1)
            return try await transcribe(model, wav: WAV.encode(samples, rate: rate))
        }

        var parts: [String] = []
        parts.reserveCapacity(chunks.count)
        for (idx, chunk) in chunks.enumerated() {
            await onChunk?(idx + 1, chunks.count)
            let text = try await transcribe(model, wav: WAV.encode(chunk, rate: rate)).trimmed
            if !text.isEmpty { parts.append(text) }
        }
        return parts.joined(separator: "\n")
    }

    private static func sampleChunks(_ samples: [Int16]) -> [[Int16]] {
        let maxPayloadBytes = max(2, maxChunkWAVBytes - WAV.headerByteCount)
        let maxSamples = max(1, maxPayloadBytes / MemoryLayout<Int16>.size)
        guard samples.count > maxSamples else { return [samples] }
        return stride(from: 0, to: samples.count, by: maxSamples).map { start in
            Array(samples[start..<min(samples.count, start + maxSamples)])
        }
    }

    // MARK: - OpenAI Whisper (multipart)

    /// Transcribe a recorded WAV. Returns the recognized text.
    static func http(_ model: ResolvedModel, wav: Data) async throws -> String {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选语音识别服务商缺少 API Key。")
        }
        // Endpoint comes from the model's ASR service (defaults to
        // /audio/transcriptions) — not hardcoded, so a provider can mount it
        // elsewhere via the service's path override.
        guard let url = model.url else {
            throw OrbitError("语音识别 Base URL 无效。")
        }

        let boundary = "orbit-\(UUID().uuidString)"
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        model.authorize(&req)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n")
        body.append("Content-Type: audio/wav\r\n\r\n")
        body.append(wav)
        body.append("\r\n")
        appendField(&body, boundary: boundary, name: "model", value: model.model)
        appendField(&body, boundary: boundary, name: "response_format", value: "json")
        if let lang = model.language, !lang.isEmpty {
            appendField(&body, boundary: boundary, name: "language", value: lang)
        }
        body.append("--\(boundary)--\r\n")
        req.httpBody = body

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw OrbitError(APIErrorHint.network(context: "语音识别", error))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            throw OrbitError(APIErrorHint.message(context: "语音识别", status: code, body: data))
        }
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (json?["text"] as? String) ?? ""
    }

    private static func appendField(_ body: inout Data, boundary: String, name: String, value: String) {
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        body.append(value)
        body.append("\r\n")
    }

    // MARK: - MiMo audio over chat completions

    /// MiMo-style ASR: the WAV is Base64-embedded as an `input_audio` content
    /// part in a `POST /chat/completions` call; the transcript comes back in the
    /// assistant message. See https://mimo.mi.com/docs (Speech Recognition).
    static func chatAudio(_ model: ResolvedModel, wav: Data) async throws -> String {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选语音识别服务商缺少 API Key。")
        }
        guard let url = model.url else {
            throw OrbitError("语音识别 Base URL 无效。")
        }

        let dataURL = "data:audio/wav;base64,\(wav.base64EncodedString())"
        let content: [[String: Any]] = [
            ["type": "input_audio", "input_audio": ["data": dataURL]]
        ]
        let lang = (model.language?.trimmed).flatMap { $0.isEmpty ? nil : $0 } ?? "auto"
        let payload: [String: Any] = [
            "model": model.model,
            "messages": [["role": "user", "content": content]],
            "asr_options": ["language": lang],
            "stream": false,
        ]

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        model.authorize(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw OrbitError(APIErrorHint.network(context: "语音识别", error))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            throw OrbitError(APIErrorHint.message(context: "语音识别", status: code, body: data))
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return chatTranscript(json).trimmed
    }

    /// Pull the transcript out of a chat-completions response. The assistant
    /// `content` is usually a plain string, but tolerate the structured
    /// content-parts array too.
    private static func chatTranscript(_ json: [String: Any]) -> String {
        guard let choices = json["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any] else { return "" }
        if let s = message["content"] as? String { return s }
        if let parts = message["content"] as? [[String: Any]] {
            return parts.compactMap { ($0["text"] as? String) ?? ($0["transcript"] as? String) }.joined()
        }
        return ""
    }
}

// MARK: - WAV encoding

enum WAV {
    static let headerByteCount = 44

    /// Encode mono Int16 PCM as a little-endian WAV container.
    static func encode(_ samples: [Int16], rate: Int) -> Data {
        let dataBytes = samples.withUnsafeBytes { Data($0) }   // little-endian on Apple Silicon
        let dataSize = dataBytes.count
        let byteRate = rate * 2

        var d = Data()
        d.append("RIFF")
        d.appendLE(UInt32(36 + dataSize))
        d.append("WAVE")
        d.append("fmt ")
        d.appendLE(UInt32(16))        // PCM fmt chunk size
        d.appendLE(UInt16(1))         // audio format = PCM
        d.appendLE(UInt16(1))         // channels = mono
        d.appendLE(UInt32(rate))
        d.appendLE(UInt32(byteRate))
        d.appendLE(UInt16(2))         // block align
        d.appendLE(UInt16(16))        // bits per sample
        d.append("data")
        d.appendLE(UInt32(dataSize))
        d.append(dataBytes)
        return d
    }
}

// MARK: - Data helpers

extension Data {
    mutating func append(_ string: String) {
        if let d = string.data(using: .utf8) { append(d) }
    }
    mutating func appendLE(_ value: UInt16) {
        Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }
    mutating func appendLE(_ value: UInt32) {
        Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
    }
}
