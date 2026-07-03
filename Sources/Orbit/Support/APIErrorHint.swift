//  APIErrorHint.swift
//  Turn raw HTTP failures into messages a user can act on. Vendors bury the
//  cause in different JSON shapes and status codes ("Invalid API Key" behind a
//  401, balance errors behind 402/403/430x, model typos behind 404), and the
//  raw body is confusing in a pill. One classifier: extract the server's own
//  message, detect the cause (key / balance / rate limit / missing model /
//  server down), and say it plainly with where to fix it.

import Foundation

enum APIErrorHint {

    /// Human-readable failure for an HTTP status + response body.
    /// `context` names the operation, e.g. "语音识别" / "大模型" / "图像生成".
    static func message(context: String, status: Int, body: Data) -> String {
        let serverText = extractServerMessage(body)
        let lowered = serverText.lowercased()

        // Balance problems hide behind many codes (402, 403, vendor customs) —
        // detect by wording first.
        let balanceWords = ["insufficient", "balance", "quota", "arrear", "欠费", "余额", "额度不足", "credit"]
        if status == 402 || balanceWords.contains(where: lowered.contains) {
            return "\(context)失败：余额不足或额度已用尽。请到该渠道商的控制台充值或更换渠道。\(detail(serverText))"
        }

        let keyWords = ["invalid api key", "invalid_key", "incorrect api key", "invalid token", "unauthorized", "authentication"]
        switch status {
        case 401:
            return "\(context)失败：API Key 无效（401）。请到「设置 → 渠道商」检查该渠道的 Key 是否正确、是否已过期。\(detail(serverText))"
        case 403:
            if keyWords.contains(where: lowered.contains) {
                return "\(context)失败：API Key 无效或已被禁用（403）。请到「设置 → 渠道商」更换 Key。\(detail(serverText))"
            }
            return "\(context)失败：没有权限（403）——这把 Key 可能无权访问该模型或接口。\(detail(serverText))"
        case 404:
            return "\(context)失败：接口或模型不存在（404）。请检查模型 id 是否正确、该渠道是否支持此能力。\(detail(serverText))"
        case 408:
            return "\(context)失败：服务商响应超时（408），请稍后重试。"
        case 429:
            return "\(context)失败：请求过于频繁或并发/配额受限（429），请稍等片刻再试。\(detail(serverText))"
        case 500...599:
            return "\(context)失败：服务商服务器故障（\(status)），请稍后重试。\(detail(serverText))"
        default:
            if keyWords.contains(where: lowered.contains) {
                return "\(context)失败：API Key 无效。请到「设置 → 渠道商」检查该渠道的 Key。\(detail(serverText))"
            }
            return "\(context)失败（HTTP \(status)）。\(detail(serverText))"
        }
    }

    /// Human-readable failure for transport-level errors (no HTTP response).
    static func network(context: String, _ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return "\(context)失败：网络未连接。请检查网络后重试。"
            case .timedOut:
                return "\(context)失败：连接超时——网络较慢或服务商无响应，请稍后重试。"
            case .cannotFindHost, .dnsLookupFailed:
                return "\(context)失败：找不到服务商地址（域名解析失败）。请检查该渠道的 Base URL。"
            case .cannotConnectToHost:
                return "\(context)失败：无法连接到服务商端点（主机/端口不可达）。请检查 Base URL 或服务是否在线。"
            case .secureConnectionFailed, .serverCertificateUntrusted:
                return "\(context)失败：与服务商建立安全连接失败（证书/TLS 问题）。"
            default:
                return "\(context)失败：网络错误——\(urlError.localizedDescription)"
            }
        }
        return "\(context)失败：\(error.localizedDescription)"
    }

    // MARK: - Internals

    /// Pull the vendor's own error text out of common JSON shapes:
    /// {error:{message}}, {error: "..."}, {message}, plain text.
    private static func extractServerMessage(_ body: Data) -> String {
        guard !body.isEmpty else { return "" }
        if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            if let err = json["error"] as? [String: Any] {
                if let msg = err["message"] as? String { return msg }
            }
            if let err = json["error"] as? String { return err }
            if let msg = json["message"] as? String { return msg }
        }
        let text = String(data: body, encoding: .utf8)?.trimmed ?? ""
        return String(text.prefix(160))
    }

    /// Append the server's own wording (shortened) so power users keep the detail.
    private static func detail(_ serverText: String) -> String {
        let t = serverText.trimmed
        guard !t.isEmpty else { return "" }
        return "（服务商信息：\(t.prefix(120))）"
    }
}
