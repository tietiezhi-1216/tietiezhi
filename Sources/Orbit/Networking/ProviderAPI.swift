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
                "鉴权失败（HTTP \(status)）：请检查 API Key；若是 MiMo，请把「鉴权」切换为 api-key。\(detail)")
        default:
            throw ProviderAPIError.http(status, String(data: body, encoding: .utf8) ?? "")
        }
    }

    /// List the model ids the provider exposes. Both the OpenAI `GET /models`
    /// and Anthropic `GET /v1/models` responses share a `{ data: [{ id }] }`
    /// shape, so one parser covers all schemes.
    static func fetchModels(_ provider: Provider) async throws -> [String] {
        let (status, body) = try await getModels(provider)
        guard status == 200 else {
            throw ProviderAPIError.http(status, String(data: body, encoding: .utf8) ?? "")
        }
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        let data = json?["data"] as? [[String: Any]] ?? []
        let ids = data.compactMap { $0["id"] as? String }
        return ids.sorted()
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
