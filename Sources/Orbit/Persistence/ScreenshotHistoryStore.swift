//  ScreenshotHistoryStore.swift
//  Persisted log of captures so a screenshot outlives its overlay — same shape
//  as DictationHistoryStore: one SQLite row per entry (JSON blob), image files
//  under ~/.orbit/screenshots/. Annotations are stored as vectors alongside the
//  clean crop, so a later re-edit feature can reopen them losslessly.

import AppKit
import Foundation

struct ScreenshotEntry: Identifiable, Codable, Hashable {
    var id: String
    var date: Date
    /// Final (annotated) PNG path — what copy/save/pin used.
    var imagePath: String
    /// The clean, annotation-free crop (kept for future re-editing).
    var originalPath: String?
    /// The vector annotations at finish time.
    var annotations: [Annotation]?
    var width: Int
    var height: Int
    /// "region" / "window".
    var source: String
    /// The AI instruction used in this capture, if any (searchable later).
    var aiPrompt: String?

    init(id: String = UUID().uuidString, date: Date, imagePath: String,
         originalPath: String? = nil, annotations: [Annotation]? = nil,
         width: Int, height: Int, source: String, aiPrompt: String? = nil) {
        self.id = id
        self.date = date
        self.imagePath = imagePath
        self.originalPath = originalPath
        self.annotations = annotations
        self.width = width
        self.height = height
        self.source = source
        self.aiPrompt = aiPrompt
    }

    var imageURL: URL { URL(fileURLWithPath: imagePath) }
}

@MainActor
final class ScreenshotHistoryStore: ObservableObject {
    @Published private(set) var entries: [ScreenshotEntry] = []

    private let db: SQLiteDB
    /// Keep the newest N entries; captures are large, unbounded growth isn't.
    private let maxEntries = 500

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    static func imagesDirectory() -> URL {
        SettingsStore.configDirectory().appendingPathComponent("screenshots", isDirectory: true)
    }

    init(db: SQLiteDB) {
        self.db = db
        db.exec("CREATE TABLE IF NOT EXISTS screenshot_history (id TEXT PRIMARY KEY, date REAL, data BLOB);")
        try? FileManager.default.createDirectory(at: Self.imagesDirectory(),
                                                 withIntermediateDirectories: true)
        load()
        enforceLimit()
    }

    func add(_ entry: ScreenshotEntry) {
        entries.insert(entry, at: 0)
        upsert(entry)
        enforceLimit()
    }

    func remove(id: String) {
        if let entry = entries.first(where: { $0.id == id }) {
            deleteFiles(of: entry)
        }
        entries.removeAll { $0.id == id }
        db.run("DELETE FROM screenshot_history WHERE id = ?;", [.text(id)])
    }

    func clear() {
        for entry in entries { deleteFiles(of: entry) }
        entries.removeAll()
        db.run("DELETE FROM screenshot_history;")
    }

    // MARK: - Internals

    private func enforceLimit() {
        guard entries.count > maxEntries else { return }
        for entry in entries[maxEntries...] {
            deleteFiles(of: entry)
            db.run("DELETE FROM screenshot_history WHERE id = ?;", [.text(entry.id)])
        }
        entries.removeLast(entries.count - maxEntries)
    }

    private func deleteFiles(of entry: ScreenshotEntry) {
        let fm = FileManager.default
        try? fm.removeItem(atPath: entry.imagePath)
        if let original = entry.originalPath { try? fm.removeItem(atPath: original) }
    }

    private func upsert(_ entry: ScreenshotEntry) {
        guard let data = try? Self.encoder.encode(entry) else { return }
        db.run("""
            INSERT INTO screenshot_history (id, date, data) VALUES (?,?,?)
            ON CONFLICT(id) DO UPDATE SET date=excluded.date, data=excluded.data;
            """,
            [.text(entry.id), .double(entry.date.timeIntervalSince1970), .blob(data)])
    }

    private func load() {
        var out: [ScreenshotEntry] = []
        db.query("SELECT data FROM screenshot_history ORDER BY date DESC;") { row in
            if let e = try? Self.decoder.decode(ScreenshotEntry.self, from: row.blob(0)) {
                out.append(e)
            }
        }
        entries = out
    }
}
