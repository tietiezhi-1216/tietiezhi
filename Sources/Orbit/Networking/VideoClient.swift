//  VideoClient.swift
//  Video generation. Every vendor is async — submit a job, poll until it
//  finishes, then fetch the asset — but the endpoints and shapes differ, so the
//  three steps branch on the wire (SiliconFlow: JSON submit/status + short-lived
//  URL; Sora: multipart create, GET status with a progress %, binary download).
//  Poll paths are derived from the base URL, not the single defaultPath.

import Foundation

enum VideoClient {

    struct Asset {
        let data: Data
        let ext: String   // "mp4"
    }

    /// Progress callbacks for the long-running job (status text + optional 0-1).
    typealias OnProgress = @MainActor (String, Double?) -> Void

    private static let pollInterval: UInt64 = 10_000_000_000   // 10s
    private static let maxPolls = 90                           // ~15 min ceiling

    /// Generate a video. `params`: `size` ("1280x720"…), `seconds` (Sora),
    /// `negative_prompt` / `seed` (SiliconFlow).
    static func generate(_ model: ResolvedModel,
                         prompt: String,
                         params: [String: String],
                         onProgress: @escaping OnProgress) async throws -> Asset {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选视频服务商缺少 API Key。")
        }
        switch model.wire {
        case .openAIVideo:
            return try await sora(model, prompt: prompt, params: params, onProgress: onProgress)
        default:
            return try await siliconflow(model, prompt: prompt, params: params, onProgress: onProgress)
        }
    }

    // MARK: - SiliconFlow: POST /video/submit → POST /video/status → download URL

    private static func siliconflow(_ model: ResolvedModel, prompt: String,
                                    params: [String: String],
                                    onProgress: @escaping OnProgress) async throws -> Asset {
        var body: [String: Any] = [
            "model": model.model,
            "prompt": prompt,
            "image_size": params["size"] ?? "1280x720",
        ]
        if let neg = params["negative_prompt"], !neg.isEmpty { body["negative_prompt"] = neg }
        if let seed = Int(params["seed"] ?? "") { body["seed"] = seed }

        await onProgress("提交任务…", nil)
        let submit = try await postJSON(model, path: "/video/submit", body: body)
        guard let requestID = submit["requestId"] as? String, !requestID.isEmpty else {
            throw OrbitError("视频提交失败：服务未返回 requestId。")
        }

        for attempt in 0..<maxPolls {
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: pollInterval)
            let status = try await postJSON(model, path: "/video/status", body: ["requestId": requestID])
            switch (status["status"] as? String ?? "").lowercased() {
            case "succeed":
                await onProgress("生成完成，正在下载…", 1)
                let results = status["results"] as? [String: Any]
                let videos = results?["videos"] as? [[String: Any]] ?? []
                guard let urlStr = videos.first?["url"] as? String else {
                    throw OrbitError("视频完成但未返回下载地址。")
                }
                return try await download(urlStr)
            case "failed":
                throw OrbitError("视频生成失败：\((status["reason"] as? String) ?? "未知原因")")
            default:
                await onProgress("生成中…（第 \(attempt + 1) 次查询）", nil)
            }
        }
        throw OrbitError("视频生成超时（15 分钟）。")
    }

    // MARK: - Sora: POST /videos (multipart) → GET /videos/{id} → binary download

    private static func sora(_ model: ResolvedModel, prompt: String,
                             params: [String: String],
                             onProgress: @escaping OnProgress) async throws -> Asset {
        // Create: multipart form-data.
        let boundary = "orbit-\(UUID().uuidString)"
        var form = Data()
        func field(_ name: String, _ value: String) {
            form.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        field("prompt", prompt)
        field("model", model.model)
        field("seconds", params["seconds"] ?? "4")
        field("size", params["size"] ?? "1280x720")
        form.append(Data("--\(boundary)--\r\n".utf8))

        var req = try request(model, path: "/videos", method: "POST")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = form

        await onProgress("提交任务…", nil)
        let created = try await send(req)
        guard let videoID = created["id"] as? String, !videoID.isEmpty else {
            throw OrbitError("视频提交失败：服务未返回任务 id。")
        }

        for _ in 0..<maxPolls {
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: pollInterval)
            let status = try await send(try request(model, path: "/videos/\(videoID)", method: "GET"))
            let state = (status["status"] as? String ?? "").lowercased()
            let progress = (status["progress"] as? Double).map { $0 / 100 }
                ?? (status["progress"] as? Int).map { Double($0) / 100 }
            switch state {
            case "completed":
                await onProgress("生成完成，正在下载…", 1)
                // Download path has two documented spellings; try both.
                for path in ["/videos/\(videoID)/content", "/videos/\(videoID)/download_content"] {
                    var dl = try request(model, path: path, method: "GET")
                    dl.timeoutInterval = 600
                    let (data, resp) = try await URLSession.shared.data(for: dl)
                    if (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty {
                        return Asset(data: data, ext: "mp4")
                    }
                }
                throw OrbitError("视频已完成但下载失败。")
            case "failed":
                let err = status["error"] as? [String: Any]
                throw OrbitError("视频生成失败：\((err?["message"] as? String) ?? "未知原因")")
            default:
                await onProgress("生成中…", progress)
            }
        }
        throw OrbitError("视频生成超时（15 分钟）。")
    }

    // MARK: - Shared plumbing

    /// A request against `baseURL + path` with auth applied (the wire's multi-
    /// endpoint flow can't go through the single `model.url`).
    private static func request(_ model: ResolvedModel, path: String, method: String) throws -> URLRequest {
        guard let url = URL(string: model.baseURL.trimmed.trimmingTrailingSlash + path) else {
            throw OrbitError("视频 Base URL 无效。")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 60
        model.authorize(&req)
        return req
    }

    private static func postJSON(_ model: ResolvedModel, path: String,
                                 body: [String: Any]) async throws -> [String: Any] {
        var req = try request(model, path: path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req)
    }

    private static func send(_ req: URLRequest) async throws -> [String: Any] {
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw OrbitError(APIErrorHint.network(context: "视频生成", error))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(code) else {
            throw OrbitError(APIErrorHint.message(context: "视频生成", status: code, body: data))
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let err = json["error"] as? [String: Any] {
            throw OrbitError("视频服务返回错误：\((err["message"] as? String) ?? "未知错误")")
        }
        return json
    }

    /// SiliconFlow's video URL expires in ~1 hour — download immediately.
    private static func download(_ urlStr: String) async throws -> Asset {
        guard let url = URL(string: urlStr) else { throw OrbitError("视频 URL 无效。") }
        var req = URLRequest(url: url)
        req.timeoutInterval = 600
        let (data, _) = try await URLSession.shared.data(for: req)
        let ext = url.pathExtension.isEmpty ? "mp4" : url.pathExtension
        return Asset(data: data, ext: ext)
    }
}
