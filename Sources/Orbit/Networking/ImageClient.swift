//  ImageClient.swift
//  Image generation, branching on the model's wire (mirrors ChatClient's
//  wire-dispatch). OpenAI-compatible and SiliconFlow shapes differ in field
//  names + response envelope. Output is normalized to in-memory `Data` (base64
//  decoded, or downloaded from the short-lived URL vendors return) so the caller
//  can display + archive it without a second round of vendor-specific handling.

import Foundation

enum ImageClient {

    /// One generated image, ready to display / archive.
    struct Asset {
        let data: Data
        let ext: String            // file extension, e.g. "png"
        let revisedPrompt: String? // some models rewrite the prompt (dall-e-3)
    }

    /// Generate one or more images. `params` carries UI options: `size`, `n`,
    /// `negative_prompt`, `steps`, `guidance`, `seed`.
    static func generate(_ model: ResolvedModel,
                         prompt: String,
                         params: [String: String]) async throws -> [Asset] {
        guard !model.apiKey.trimmed.isEmpty else {
            throw OrbitError("所选图像服务商缺少 API Key。")
        }
        guard let url = model.url else { throw OrbitError("图像 Base URL 无效。") }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 180
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        model.authorize(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: body(model: model, prompt: prompt, params: params))

        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw OrbitError(APIErrorHint.network(context: "图像生成", error))
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            throw OrbitError(APIErrorHint.message(context: "图像生成", status: code, body: data))
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let err = json["error"] as? [String: Any] {
            throw OrbitError("图像生成失败：\((err["message"] as? String) ?? "未知错误")")
        }
        return try await assets(from: json, wire: model.wire)
    }

    // MARK: - Request body (wire-specific)

    private static func body(model: ResolvedModel, prompt: String, params: [String: String]) -> [String: Any] {
        let size = params["size"] ?? "1024x1024"
        let n = Int(params["n"] ?? "1") ?? 1
        switch model.wire {
        case .siliconflowImage:
            var p: [String: Any] = [
                "model": model.model,
                "prompt": prompt,
                "image_size": size,
                "batch_size": max(1, min(n, 4)),
            ]
            if let neg = params["negative_prompt"], !neg.isEmpty { p["negative_prompt"] = neg }
            if let steps = Int(params["steps"] ?? "") { p["num_inference_steps"] = steps }
            if let g = Double(params["guidance"] ?? "") { p["guidance_scale"] = g }
            if let seed = Int(params["seed"] ?? "") { p["seed"] = seed }
            return p
        default:
            // OpenAI-compatible (OpenAI / New API / custom). Don't force
            // response_format — gpt-image-* always returns base64, dall-e returns
            // a URL; `assets(from:)` handles both.
            var p: [String: Any] = ["model": model.model, "prompt": prompt, "size": size]
            if n > 1 { p["n"] = n }
            return p
        }
    }

    // MARK: - Response → assets (download URLs, decode base64)

    private static func assets(from json: [String: Any], wire: Wire) async throws -> [Asset] {
        switch wire {
        case .siliconflowImage:
            let images = json["images"] as? [[String: Any]] ?? []
            var out: [Asset] = []
            for img in images {
                if let urlStr = img["url"] as? String, let (d, ext) = try? await download(urlStr) {
                    out.append(Asset(data: d, ext: ext, revisedPrompt: nil))
                }
            }
            guard !out.isEmpty else { throw OrbitError("图像服务未返回可用结果。") }
            return out
        default:
            let items = json["data"] as? [[String: Any]] ?? []
            var out: [Asset] = []
            for item in items {
                let revised = item["revised_prompt"] as? String
                if let b64 = item["b64_json"] as? String, let d = Data(base64Encoded: b64) {
                    out.append(Asset(data: d, ext: "png", revisedPrompt: revised))
                } else if let urlStr = item["url"] as? String, let (d, ext) = try? await download(urlStr) {
                    out.append(Asset(data: d, ext: ext, revisedPrompt: revised))
                }
            }
            guard !out.isEmpty else { throw OrbitError("图像服务未返回可用结果。") }
            return out
        }
    }

    /// Download a (short-lived) asset URL to `Data` immediately.
    private static func download(_ urlStr: String) async throws -> (Data, String) {
        guard let url = URL(string: urlStr) else { throw OrbitError("图像 URL 无效。") }
        let (data, resp) = try await URLSession.shared.data(from: url)
        let ext: String
        switch (resp.mimeType ?? "").lowercased() {
        case "image/jpeg", "image/jpg": ext = "jpg"
        case "image/webp":              ext = "webp"
        default:                        ext = url.pathExtension.isEmpty ? "png" : url.pathExtension
        }
        return (data, ext)
    }
}
