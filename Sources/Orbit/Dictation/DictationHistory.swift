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

    private let db: SQLiteDB
    private var pruneTimer: Timer?

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    init(db: SQLiteDB) {
        self.db = db
        db.exec("CREATE TABLE IF NOT EXISTS dictation_history (id TEXT PRIMARY KEY, date REAL, data BLOB);")
        migrateFromJSONIfNeeded()
        load()
        pruneExpired()
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pruneExpired() }
        }
    }

    /// Record a new result at the top of the list. Kept cheap for the dictation
    /// hot path: a single row INSERT + in-memory trim (no filesystem scan).
    /// Expired disk artifacts + rows are swept by the launch/hourly `pruneExpired()`.
    func add(_ entry: DictationEntry) {
        entries.insert(entry, at: 0)
        upsert(entry)
        dropExpiredEntries()
    }

    func remove(id: String) {
        entries.first(where: { $0.id == id }).map { DictationAudioArchive.delete($0.artifacts) }
        entries.removeAll { $0.id == id }
        db.run("DELETE FROM dictation_history WHERE id = ?;", [.text(id)])
    }

    func clear() {
        for entry in entries {
            DictationAudioArchive.delete(entry.artifacts)
        }
        DictationAudioArchive.clearAll()
        entries.removeAll()
        db.run("DELETE FROM dictation_history;")
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
        db.run("DELETE FROM dictation_history WHERE date < ?;", [.double(cutoff.timeIntervalSince1970)])
    }

    /// In-memory only: trim entries past the retention window without touching disk.
    private func dropExpiredEntries() {
        let cutoff = Date().addingTimeInterval(-Double(DictationAudioArchive.retentionDays) * 24 * 60 * 60)
        entries.removeAll { $0.date < cutoff }
    }

    // MARK: - Persistence (SQLite)

    private func upsert(_ entry: DictationEntry) {
        guard let data = try? Self.encoder.encode(entry) else { return }
        db.run("""
            INSERT INTO dictation_history (id, date, data) VALUES (?,?,?)
            ON CONFLICT(id) DO UPDATE SET date=excluded.date, data=excluded.data;
            """,
            [.text(entry.id), .double(entry.date.timeIntervalSince1970), .blob(data)])
    }

    private func load() {
        var out: [DictationEntry] = []
        db.query("SELECT data FROM dictation_history ORDER BY date DESC;") { row in
            if let e = try? Self.decoder.decode(DictationEntry.self, from: row.blob(0)) { out.append(e) }
        }
        entries = out
    }

    /// One-time import of the previous history.json into the fresh table.
    private func migrateFromJSONIfNeeded() {
        guard db.scalarInt("SELECT COUNT(*) FROM dictation_history;") == 0 else { return }
        let url = SettingsStore.configDirectory().appendingPathComponent("history.json")
        guard let data = try? Data(contentsOf: url),
              let decoded = try? Self.decoder.decode([DictationEntry].self, from: data) else { return }
        db.transaction { for e in decoded { upsert(e) } }
        try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("migrated"))
    }
}
