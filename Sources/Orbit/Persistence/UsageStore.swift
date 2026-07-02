//  UsageStore.swift
//  Persisted, accumulating usage log for cost accounting. Kept in its own
//  `usage.json` under Application Support (like DictationHistoryStore) so it
//  never bloats config.json. Records are append-only; cost is frozen per record.

import Foundation
import Combine

@MainActor
final class UsageStore: ObservableObject {
    @Published private(set) var records: [UsageRecord] = []

    private let fileURL: URL
    private var saveWorkItem: DispatchWorkItem?

    init() {
        let dir = SettingsStore.configDirectory()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("usage.json")
        load()
    }

    /// Append a completed usage event (newest first) and persist.
    func add(_ record: UsageRecord) {
        records.insert(record, at: 0)
        scheduleSave()
    }

    func clear() {
        records.removeAll()
        scheduleSave()
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

    // MARK: - Persistence

    private func load() {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? decoder.decode([UsageRecord].self, from: data)
        else { return }
        records = decoded
    }

    private func scheduleSave() {
        saveWorkItem?.cancel()
        let snapshot = records
        let url = fileURL
        let item = DispatchWorkItem {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted]
            guard let data = try? encoder.encode(snapshot) else { return }
            try? data.write(to: url, options: .atomic)
        }
        saveWorkItem = item
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5, execute: item)
    }
}
