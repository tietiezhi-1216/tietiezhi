//  SQLite.swift
//  A thin wrapper over the system libsqlite3 (no external dependency — macOS
//  ships it). Orbit uses it for the append-heavy / growing datasets where a
//  single JSON document would mean loading everything into memory and rewriting
//  the whole file on each change: conversations, usage records, dictation
//  history. Config stays JSON (document-shaped, tolerant migration).
//
//  The connection is used only from the main actor (all stores are @MainActor),
//  so it needs no cross-thread coordination; WAL mode keeps writes fast + crash-
//  safe. Values bind by 1-based position.

import Foundation
import SQLite3

/// SQLite requires a copy of transient text/blob bindings (the Swift buffer may
/// be gone before the statement runs).
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLiteValue {
    case int(Int64)
    case double(Double)
    case text(String)
    case blob(Data)
    case null

    fileprivate func bind(_ stmt: OpaquePointer?, _ index: Int32) {
        switch self {
        case .int(let v):    sqlite3_bind_int64(stmt, index, v)
        case .double(let v): sqlite3_bind_double(stmt, index, v)
        case .text(let v):   sqlite3_bind_text(stmt, index, v, -1, SQLITE_TRANSIENT)
        case .blob(let d):
            if d.isEmpty {
                sqlite3_bind_zeroblob(stmt, index, 0)
            } else {
                d.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32(d.count), SQLITE_TRANSIENT) }
            }
        case .null:          sqlite3_bind_null(stmt, index)
        }
    }
}

/// One result row — read columns by 0-based index.
struct SQLiteRow {
    fileprivate let stmt: OpaquePointer?

    func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
    func double(_ i: Int32) -> Double { sqlite3_column_double(stmt, i) }
    func text(_ i: Int32) -> String { sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "" }
    func blob(_ i: Int32) -> Data {
        guard let p = sqlite3_column_blob(stmt, i) else { return Data() }
        return Data(bytes: p, count: Int(sqlite3_column_bytes(stmt, i)))
    }
}

final class SQLiteDB {
    private var handle: OpaquePointer?

    init(path: String) {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        if sqlite3_open_v2(path, &handle, flags, nil) != SQLITE_OK {
            NSLog("[sqlite] open failed: \(lastError)")
        }
        exec("PRAGMA journal_mode=WAL;")
        exec("PRAGMA busy_timeout=3000;")
    }

    deinit { sqlite3_close(handle) }

    private var lastError: String { String(cString: sqlite3_errmsg(handle)) }

    /// Run one or more statements with no bindings (DDL, PRAGMA).
    @discardableResult
    func exec(_ sql: String) -> Bool {
        sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK
    }

    /// Execute a single statement with bound parameters (INSERT/UPDATE/DELETE).
    func run(_ sql: String, _ params: [SQLiteValue] = []) {
        guard let stmt = prepare(sql, params) else { return }
        if sqlite3_step(stmt) != SQLITE_DONE { NSLog("[sqlite] run failed: \(lastError)") }
        sqlite3_finalize(stmt)
    }

    /// Query rows, invoking `row` for each.
    func query(_ sql: String, _ params: [SQLiteValue] = [], _ row: (SQLiteRow) -> Void) {
        guard let stmt = prepare(sql, params) else { return }
        while sqlite3_step(stmt) == SQLITE_ROW { row(SQLiteRow(stmt: stmt)) }
        sqlite3_finalize(stmt)
    }

    /// Convenience: single scalar Int (e.g. COUNT(*)).
    func scalarInt(_ sql: String, _ params: [SQLiteValue] = []) -> Int64 {
        var result: Int64 = 0
        query(sql, params) { result = $0.int(0) }
        return result
    }

    /// Run `body` inside a transaction (batches many writes into one fsync).
    func transaction(_ body: () -> Void) {
        exec("BEGIN;")
        body()
        exec("COMMIT;")
    }

    private func prepare(_ sql: String, _ params: [SQLiteValue]) -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &stmt, nil) == SQLITE_OK else {
            NSLog("[sqlite] prepare failed: \(lastError) — \(sql)")
            return nil
        }
        for (i, p) in params.enumerated() { p.bind(stmt, Int32(i + 1)) }
        return stmt
    }
}
