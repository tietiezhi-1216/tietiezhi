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

    /// Ping `/models` to validate base URL + API key. Returns a status string.
    static func test(_ provider: Provider) async throws -> String {
        let (status, _) = try await getModels(provider)
        return status == 200 ? "连接正常" : "HTTP \(status)"
    }

    /// List the model ids the provider exposes via `GET /models`.
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
        let base = provider.baseURL.trimmingTrailingSlash
        guard let url = URL(string: base + "/models") else { throw ProviderAPIError.badURL }
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        req.setValue("Bearer \(provider.apiKey)", forHTTPHeaderField: "Authorization")
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
