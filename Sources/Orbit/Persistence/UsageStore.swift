//  UsageStore.swift
//  Persisted, accumulating usage log for cost accounting. Append-only records in
//  the shared SQLite database (a row per event) so adding one is a single INSERT
//  instead of rewriting the whole log. The in-memory list drives the stats view.

import Foundation
import Combine

@MainActor
final class UsageStore: ObservableObject {
    @Published private(set) var records: [UsageRecord] = []

    private let db: SQLiteDB

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e
    }()
    private static let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()

    init(db: SQLiteDB) {
        self.db = db
        db.exec("CREATE TABLE IF NOT EXISTS usage_records (rowid INTEGER PRIMARY KEY AUTOINCREMENT, date REAL, data BLOB);")
        migrateFromJSONIfNeeded()
        load()
    }

    /// Append a completed usage event (newest first) and persist (one INSERT).
    func add(_ record: UsageRecord) {
        records.insert(record, at: 0)
        if let data = try? Self.encoder.encode(record) {
            db.run("INSERT INTO usage_records (date, data) VALUES (?,?);",
                   [.double(record.date.timeIntervalSince1970), .blob(data)])
        }
    }

    func clear() {
        records.removeAll()
        db.run("DELETE FROM usage_records;")
    }

    // MARK: - Aggregations (for the stats view)

    /// Total cost grouped by currency (records without a price are ignored).
    var totalCostByCurrency: [(currency: String, cost: Double)] {
        var sums: [String: Double] = [:]
        for r in records {
            guard let c = r.cost, let cur = r.currency else { continue }
            sums[cur, default: 0] += c
        }
        return sums.sorted { $0.value > $1.value }.map { ($0.key, $0.value) }
    }

    var totalInputTokens: Int { records.reduce(0) { $0 + ($1.inputTokens ?? 0) } }
    var totalOutputTokens: Int { records.reduce(0) { $0 + ($1.outputTokens ?? 0) } }

    /// Spend per model label, most expensive first. Currency is taken per group
    /// (a label maps to one model → one currency in practice).
    func breakdownByModel() -> [(label: String, cost: Double, currency: String, count: Int)] {
        var grouped: [String: (cost: Double, currency: String, count: Int)] = [:]
        for r in records {
            var g = grouped[r.label] ?? (0, r.currency ?? "", 0)
            g.cost += r.cost ?? 0
            g.count += 1
            if g.currency.isEmpty, let c = r.currency { g.currency = c }
            grouped[r.label] = g
        }
        return grouped
            .map { ($0.key, $0.value.cost, $0.value.currency, $0.value.count) }
            .sorted { $0.cost > $1.cost }
    }

    /// Count + cost per source ("chat" / "asr" / "polish").
    func breakdownBySource() -> [(source: String, count: Int)] {
        Dictionary(grouping: records, by: \.source)
            .map { ($0.key, $0.value.count) }
            .sorted { $0.count > $1.count }
    }

    // MARK: - Persistence (SQLite)

    private func load() {
        var out: [UsageRecord] = []
        db.query("SELECT data FROM usage_records ORDER BY date DESC;") { row in
            if let r = try? Self.decoder.decode(UsageRecord.self, from: row.blob(0)) { out.append(r) }
        }
        records = out
    }

    /// One-time import of the previous usage.json into the fresh table.
    private func migrateFromJSONIfNeeded() {
        guard db.scalarInt("SELECT COUNT(*) FROM usage_records;") == 0 else { return }
        let url = SettingsStore.configDirectory().appendingPathComponent("usage.json")
        guard let data = try? Data(contentsOf: url),
              let decoded = try? Self.decoder.decode([UsageRecord].self, from: data) else { return }
        db.transaction {
            for r in decoded {
                if let d = try? Self.encoder.encode(r) {
                    db.run("INSERT INTO usage_records (date, data) VALUES (?,?);",
                           [.double(r.date.timeIntervalSince1970), .blob(d)])
                }
            }
        }
        try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("migrated"))
    }
}
