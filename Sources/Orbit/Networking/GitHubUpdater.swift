//  GitHubUpdater.swift
//  App update checks backed by GitHub Releases assets produced by CI.

import CryptoKit
import Foundation

enum GitHubUpdater {
    static let owner = "tietiezhi-1216"
    static let repository = "Orbit"
    static let releasesPage = URL(string: "https://github.com/\(owner)/\(repository)/releases")!

    private static let releasesAPI = URL(string: "https://api.github.com/repos/\(owner)/\(repository)/releases")!
    fileprivate static let userAgent = "Orbit-Updater"

    static var currentArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    static func checkForUpdate(
        currentVersion: String,
        architecture: String = currentArchitecture
    ) async throws -> AppUpdate? {
        let current = SemanticVersion(currentVersion) ?? .zero
        let data = try await fetchData(from: releasesAPI, timeout: 20)
        let releases = try JSONDecoder().decode([GitHubRelease].self, from: data)

        let candidates = releases
            .filter { !$0.draft }
            .compactMap { release -> (release: GitHubRelease, version: SemanticVersion)? in
                guard let version = SemanticVersion(release.tagName) else { return nil }
                return (release, version)
            }
            .sorted { $0.version > $1.version }

        for candidate in candidates {
            guard candidate.version > current else { return nil }
            guard let update = candidate.release.update(for: candidate.version.description, architecture: architecture) else {
                throw GitHubUpdaterError.noCompatibleAsset(version: candidate.version.description, architecture: architecture)
            }
            return update
        }

        return nil
    }

    static func downloadAndVerify(
        _ update: AppUpdate,
        progress: @escaping (Double) -> Void
    ) async throws -> URL {
        let expectedChecksum = try await fetchExpectedChecksum(from: update.checksumURL)
        let directory = try updatesDirectory()
        let destination = directory.appendingPathComponent(update.assetName)

        progress(0)
        let fileURL = try await downloadFile(from: update.downloadURL, to: destination, progress: progress)
        let actualChecksum = try sha256Hex(of: fileURL)

        guard actualChecksum.caseInsensitiveCompare(expectedChecksum) == .orderedSame else {
            try? FileManager.default.removeItem(at: fileURL)
            throw GitHubUpdaterError.checksumMismatch(expected: expectedChecksum, actual: actualChecksum)
        }

        progress(1)
        return fileURL
    }

    private static func fetchExpectedChecksum(from url: URL) async throws -> String {
        let data = try await fetchData(from: url, timeout: 20)
        guard let text = String(data: data, encoding: .utf8) else {
            throw GitHubUpdaterError.invalidChecksum
        }
        guard let checksum = text
            .split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
            .first
            .map(String.init),
              checksum.count == 64,
              checksum.allSatisfy({ $0.isHexDigit })
        else {
            throw GitHubUpdaterError.invalidChecksum
        }
        return checksum
    }

    private static func fetchData(from url: URL, timeout: TimeInterval) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                throw GitHubUpdaterError.http(code)
            }
            return data
        } catch let error as GitHubUpdaterError {
            throw error
        } catch {
            throw GitHubUpdaterError.transport(error.localizedDescription)
        }
    }

    private static func downloadFile(
        from url: URL,
        to destination: URL,
        progress: @escaping (Double) -> Void
    ) async throws -> URL {
        let delegate = UpdateDownloadDelegate(destination: destination, progress: progress)
        return try await delegate.download(from: url)
    }

    private static func sha256Hex(of fileURL: URL) throws -> String {
        let data = try Data(contentsOf: fileURL)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func updatesDirectory() throws -> URL {
        let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        let directory = cache
            .appendingPathComponent("com.orbit.app", isDirectory: true)
            .appendingPathComponent("Updates", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

private enum GitHubUpdaterError: LocalizedError {
    case http(Int)
    case transport(String)
    case noCompatibleAsset(version: String, architecture: String)
    case invalidChecksum
    case checksumMismatch(expected: String, actual: String)
    case downloadDidNotFinish

    var errorDescription: String? {
        switch self {
        case .http(let code):
            return "GitHub 请求失败（HTTP \(code)）"
        case .transport(let message):
            return "网络请求失败：\(message)"
        case .noCompatibleAsset(let version, let architecture):
            return "发现 Orbit \(version)，但没有适用于 macOS \(architecture) 的 DMG 安装包。"
        case .invalidChecksum:
            return "更新包校验文件无效。"
        case .checksumMismatch(let expected, let actual):
            return "更新包 SHA256 校验失败：期望 \(expected)，实际 \(actual)。"
        case .downloadDidNotFinish:
            return "更新包下载未完成。"
        }
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let name: String?
    let body: String?
    let htmlURL: URL
    let draft: Bool
    let prerelease: Bool
    let assets: [GitHubAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case name
        case body
        case htmlURL = "html_url"
        case draft
        case prerelease
        case assets
    }

    func update(for version: String, architecture: String) -> AppUpdate? {
        let dmgAssets = assets.filter { $0.name.lowercased().hasSuffix(".dmg") }
        let architectureNeedle = "macos-\(architecture)"
        let dmg = dmgAssets.first { $0.name.lowercased().contains(architectureNeedle) }
            ?? (dmgAssets.count == 1 ? dmgAssets.first : nil)

        guard let dmg else { return nil }

        let checksum = assets.first { $0.name == "\(dmg.name).sha256" }
            ?? assets.first { $0.name.lowercased().hasSuffix(".sha256") && $0.name.contains(dmg.name) }
            ?? (assets.filter { $0.name.lowercased().hasSuffix(".sha256") }.count == 1
                ? assets.first { $0.name.lowercased().hasSuffix(".sha256") }
                : nil)

        guard let checksum else { return nil }

        return AppUpdate(
            version: version,
            tagName: tagName,
            title: name ?? "",
            releaseNotes: body ?? "",
            releaseURL: htmlURL,
            assetName: dmg.name,
            assetSize: dmg.size,
            downloadURL: dmg.browserDownloadURL,
            checksumURL: checksum.browserDownloadURL,
            isPrerelease: prerelease
        )
    }
}

private struct GitHubAsset: Decodable {
    let name: String
    let size: Int64
    let browserDownloadURL: URL

    enum CodingKeys: String, CodingKey {
        case name
        case size
        case browserDownloadURL = "browser_download_url"
    }
}

private struct SemanticVersion: Comparable, CustomStringConvertible {
    static let zero = SemanticVersion(numbers: [0, 0, 0])

    let numbers: [Int]

    init?(_ raw: String) {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased().hasPrefix("v") {
            value.removeFirst()
        }

        let main = value.split(separator: "-", maxSplits: 1).first.map(String.init) ?? value
        let parts = main.split(separator: ".")
        guard !parts.isEmpty else { return nil }

        var parsed: [Int] = []
        parsed.reserveCapacity(parts.count)
        for part in parts {
            guard let number = Int(part) else { return nil }
            parsed.append(number)
        }
        numbers = parsed
    }

    private init(numbers: [Int]) {
        self.numbers = numbers
    }

    var description: String {
        numbers.map(String.init).joined(separator: ".")
    }

    static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
        let count = max(lhs.numbers.count, rhs.numbers.count)
        for index in 0..<count {
            let left = index < lhs.numbers.count ? lhs.numbers[index] : 0
            let right = index < rhs.numbers.count ? rhs.numbers[index] : 0
            if left != right { return left < right }
        }
        return false
    }
}

private final class UpdateDownloadDelegate: NSObject, URLSessionDownloadDelegate {
    private let destination: URL
    private let progress: (Double) -> Void
    private var continuation: CheckedContinuation<URL, Error>?
    private var completionError: Error?
    private var completedFileURL: URL?
    private var didResume = false

    init(destination: URL, progress: @escaping (Double) -> Void) {
        self.destination = destination
        self.progress = progress
    }

    func download(from url: URL) async throws -> URL {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30 * 60

        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            var request = URLRequest(url: url)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue(GitHubUpdater.userAgent, forHTTPHeaderField: "User-Agent")
            session.downloadTask(with: request).resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard totalBytesExpectedToWrite > 0 else { return }
        progress(min(max(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite), 0), 1))
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        do {
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: location, to: destination)
            completedFileURL = destination
        } catch {
            completionError = error
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            resume(.failure(GitHubUpdaterError.transport(error.localizedDescription)))
            return
        }

        if let code = (task.response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(code) {
            if FileManager.default.fileExists(atPath: destination.path) {
                try? FileManager.default.removeItem(at: destination)
            }
            resume(.failure(GitHubUpdaterError.http(code)))
            return
        }

        if let completionError {
            resume(.failure(completionError))
            return
        }

        guard let completedFileURL else {
            resume(.failure(GitHubUpdaterError.downloadDidNotFinish))
            return
        }

        resume(.success(completedFileURL))
    }

    private func resume(_ result: Result<URL, Error>) {
        guard !didResume, let continuation else { return }
        didResume = true
        continuation.resume(with: result)
    }
}
