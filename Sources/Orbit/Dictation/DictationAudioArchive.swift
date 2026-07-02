//  DictationAudioArchive.swift
//  Per-dictation artifact retention. Every committed recording gets a session
//  folder immediately; ASR and polish outputs are written as soon as each stage
//  finishes. Sessions are retained for seven days.

import Foundation

struct DictationArtifactPaths: Codable, Hashable {
    var directoryPath: String
    var audioPath: String
    var transcriptPath: String
    var polishedPath: String
    var manifestPath: String

    var directoryURL: URL { URL(fileURLWithPath: directoryPath) }
    var audioURL: URL { URL(fileURLWithPath: audioPath) }
    var transcriptURL: URL { URL(fileURLWithPath: transcriptPath) }
    var polishedURL: URL { URL(fileURLWithPath: polishedPath) }
    var manifestURL: URL { URL(fileURLWithPath: manifestPath) }
}

enum DictationAudioArchive {
    static let retentionDays = 7
    private static let manifestFileName = "manifest.json"

    /// All disk I/O runs here, serially and off the main thread. Serial ordering
    /// guarantees a session's directory exists before its transcript/polish writes
    /// land, and keeps the dictation hot path (submit → record) free of blocking
    /// file work — the old synchronous encode + full-directory prune stuttered the
    /// UI on every utterance as history grew.
    private static let ioQueue = DispatchQueue(label: "com.orbit.dictation.archive", qos: .utility)

    static var directory: URL {
        SettingsStore.configDirectory().appendingPathComponent("dictations", isDirectory: true)
    }

    /// Returns the (deterministic) artifact paths immediately; the actual audio +
    /// manifest write happens asynchronously on `ioQueue`. Paths are derived from
    /// the session name, so callers can reference them before the bytes land.
    static func createSession(id: String,
                              date: Date,
                              samples: [Int16],
                              rate: Int,
                              seq: Int,
                              frontApp: String?,
                              polish: Bool) -> DictationArtifactPaths? {
        guard !samples.isEmpty else { return nil }
        let session = "\(timestamp(date))-seq\(seq)-\(id)"
        let dir = directory.appendingPathComponent(session, isDirectory: true)
        let paths = DictationArtifactPaths(
            directoryPath: dir.path,
            audioPath: dir.appendingPathComponent("audio.wav").path,
            transcriptPath: dir.appendingPathComponent("transcript.txt").path,
            polishedPath: dir.appendingPathComponent("polished.txt").path,
            manifestPath: dir.appendingPathComponent(manifestFileName).path
        )
        ioQueue.async {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try WAV.encode(samples, rate: rate).write(to: paths.audioURL, options: .atomic)
                writeManifest(
                    paths: paths,
                    date: date,
                    seq: seq,
                    rate: rate,
                    sampleCount: samples.count,
                    frontApp: frontApp,
                    polishRequested: polish,
                    status: "recorded"
                )
            } catch {
                NSLog("[dictation] failed to archive recording: \(error.localizedDescription)")
            }
        }
        return paths
    }

    static func saveTranscript(_ transcript: String, paths: DictationArtifactPaths?) {
        guard let paths else { return }
        ioQueue.async {
            do {
                try transcript.write(to: paths.transcriptURL, atomically: true, encoding: .utf8)
                patchManifest(paths: paths, status: "transcribed")
            } catch {
                NSLog("[dictation] failed to save transcript: \(error.localizedDescription)")
            }
        }
    }

    static func savePolished(_ polished: String, paths: DictationArtifactPaths?) {
        guard let paths else { return }
        ioQueue.async {
            do {
                try polished.write(to: paths.polishedURL, atomically: true, encoding: .utf8)
                patchManifest(paths: paths, status: "polished")
            } catch {
                NSLog("[dictation] failed to save polished text: \(error.localizedDescription)")
            }
        }
    }

    static func saveFailure(_ failure: String, paths: DictationArtifactPaths?) {
        guard let paths else { return }
        ioQueue.async {
            patchManifest(paths: paths, status: "failed", failure: failure)
        }
    }

    static func delete(_ paths: DictationArtifactPaths?) {
        guard let paths else { return }
        let dir = paths.directoryURL
        ioQueue.async { try? FileManager.default.removeItem(at: dir) }
    }

    static func delete(directoryPath: String?) {
        guard let directoryPath, !directoryPath.isEmpty else { return }
        ioQueue.async { try? FileManager.default.removeItem(at: URL(fileURLWithPath: directoryPath)) }
    }

    static func clearAll() {
        ioQueue.async {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
    }

    static func pruneExpired(now: Date = Date()) {
        let cutoff = now.addingTimeInterval(-Double(retentionDays) * 24 * 60 * 60)
        ioQueue.async {
            guard let urls = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) else { return }

            for url in urls where isExpired(url, cutoff: cutoff) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    private static func writeManifest(paths: DictationArtifactPaths,
                                      date: Date,
                                      seq: Int,
                                      rate: Int,
                                      sampleCount: Int,
                                      frontApp: String?,
                                      polishRequested: Bool,
                                      status: String,
                                      failure: String? = nil) {
        var manifest: [String: Any] = [
            "createdAt": ISO8601DateFormatter().string(from: date),
            "expiresAt": ISO8601DateFormatter().string(
                from: date.addingTimeInterval(Double(retentionDays) * 24 * 60 * 60)
            ),
            "sequence": seq,
            "sampleRate": rate,
            "sampleCount": sampleCount,
            "durationSeconds": Double(sampleCount) / Double(max(1, rate)),
            "polishRequested": polishRequested,
            "status": status,
            "audio": "audio.wav",
            "transcript": "transcript.txt",
            "polished": "polished.txt",
        ]
        if let frontApp { manifest["frontApp"] = frontApp }
        if let failure { manifest["failure"] = failure }
        writeJSON(manifest, to: paths.manifestURL)
    }

    private static func patchManifest(paths: DictationArtifactPaths, status: String, failure: String? = nil) {
        var manifest = readManifest(paths.manifestURL)
        manifest["status"] = status
        manifest["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        if let failure { manifest["failure"] = failure }
        writeJSON(manifest, to: paths.manifestURL)
    }

    private static func readManifest(_ url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return object
    }

    private static func writeJSON(_ object: [String: Any], to url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        else { return }
        try? data.write(to: url, options: .atomic)
    }

    private static func isExpired(_ url: URL, cutoff: Date) -> Bool {
        if let createdAt = createdAt(from: url) {
            return createdAt < cutoff
        }
        let modified = ((try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate)
            ?? .distantPast
        return modified < cutoff
    }

    /// Derive the creation time from the session folder name (`yyyyMMdd-HHmmss-…`)
    /// rather than opening each manifest — pruning must not read N files just to
    /// decide what to delete. Falls back to the manifest's `createdAt` for any
    /// legacy folder whose name doesn't parse.
    private static func createdAt(from directory: URL) -> Date? {
        let stamp = String(directory.lastPathComponent.prefix(15))  // yyyyMMdd-HHmmss
        if let date = sessionNameFormatter.date(from: stamp) { return date }

        let manifestURL = directory.appendingPathComponent(manifestFileName)
        guard let data = try? Data(contentsOf: manifestURL),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let created = object["createdAt"] as? String
        else { return nil }
        return ISO8601DateFormatter().date(from: created)
    }

    private static let sessionNameFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()

    private static func timestamp(_ date: Date) -> String {
        sessionNameFormatter.string(from: date)
    }
}
