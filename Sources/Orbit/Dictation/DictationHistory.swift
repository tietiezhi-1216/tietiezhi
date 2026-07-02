//  DictationHistory.swift
//  A persisted log of dictation results so a transcript is never lost once the
//  pill disappears. Each entry keeps the raw recognized text, the polished
//  rewrite (if any), and whether it was auto-inserted. Stored as its own JSON
//  file under Application Support — kept out of config.json so transcripts never
//  bloat the settings document.

import Foundation
import Combine

struct DictationEntry: Identifiable, Codable, Hashable {
    var id: String
    var date: Date
    /// Raw ASR text.
    var transcript: String
    /// LLM-polished text, when polishing ran and produced something.
    var polished: String?
    /// Whether the result was pasted into the focused app.
    var inserted: Bool
    /// Which template produced this (the template name), or "raw" for
    /// transcribe-only sessions. Optional so older history still decodes.
    var mode: String?
    /// Error/cancel state when the recording did not produce final text.
    var failure: String?
    /// Per-stage files retained for seven days.
    var artifacts: DictationArtifactPaths?

    /// The text actually delivered: the polish if present, else the raw transcript.
    var finalText: String {
        if let p = polished, !p.isEmpty { return p }
        return transcript
    }

    init(id: String = UUID().uuidString,
         date: Date,
         transcript: String,
         polished: String? = nil,
         inserted: Bool,
         mode: String? = nil,
         failure: String? = nil,
         artifacts: DictationArtifactPaths? = nil) {
        self.id = id
        self.date = date
        self.transcript = transcript
        self.polished = polished
        self.inserted = inserted
        self.mode = mode
        self.failure = failure
        self.artifacts = artifacts
    }
}

extension DictationEntry {
    var audioURL: URL? { fileURL(artifacts?.audioPath) }
    var transcriptFileURL: URL? { fileURL(artifacts?.transcriptPath) }
    var polishedFileURL: URL? { fileURL(artifacts?.polishedPath) }
    var artifactDirectoryURL: URL? { fileURL(artifacts?.directoryPath, mustExist: true) }
    var expiresAt: Date {
        date.addingTimeInterval(Double(DictationAudioArchive.retentionDays) * 24 * 60 * 60)
    }

    private func fileURL(_ path: String?, mustExist: Bool = false) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if mustExist, !FileManager.default.fileExists(atPath: path) { return nil }
        return URL(fileURLWithPath: path)
    }
}

@MainActor
final class DictationHistoryStore: ObservableObject {
    @Published private(set) var entries: [DictationEntry] = []

    private let fileURL: URL
    private var pruneTimer: Timer?

    init() {
        let dir = SettingsStore.configDirectory()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("history.json")
        load()
        pruneExpired()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pruneExpired() }
        }
    }

    /// Record a new result at the top of the list. Kept cheap for the dictation
    /// hot path: only the in-memory list is trimmed here — no filesystem scan.
    /// Expired disk artifacts are swept by the launch/hourly `pruneExpired()`.
    func add(_ entry: DictationEntry) {
        entries.insert(entry, at: 0)
        dropExpiredEntries()
        save()
    }

    func remove(id: String) {
        entries.first(where: { $0.id == id }).map { DictationAudioArchive.delete($0.artifacts) }
        entries.removeAll { $0.id == id }
        save()
    }

    func clear() {
        for entry in entries {
            DictationAudioArchive.delete(entry.artifacts)
        }
        DictationAudioArchive.clearAll()
        entries.removeAll()
        save()
    }

    /// Full sweep: drop expired entries, delete their retained artifacts, and let
    /// the archive prune any orphaned session folders. Runs on launch, hourly, and
    /// from the “清理过期” button — never on the per-utterance path.
    func pruneExpired() {
        let cutoff = Date().addingTimeInterval(-Double(DictationAudioArchive.retentionDays) * 24 * 60 * 60)
        for entry in entries where entry.date < cutoff {
            DictationAudioArchive.delete(entry.artifacts)
        }
        entries.removeAll { $0.date < cutoff }
        DictationAudioArchive.pruneExpired()
        save()
    }

    /// In-memory only: trim entries past the retention window without touching disk.
    private func dropExpiredEntries() {
        let cutoff = Date().addingTimeInterval(-Double(DictationAudioArchive.retentionDays) * 24 * 60 * 60)
        entries.removeAll { $0.date < cutoff }
    }

    // MARK: - Persistence

    private func load() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([DictationEntry].self, from: data)
        else { return }
        entries = decoded
    }

    private func save() {
        let snapshot = entries
        let url = fileURL
        DispatchQueue.global(qos: .utility).async {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted]
            guard let data = try? encoder.encode(snapshot) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }
}
