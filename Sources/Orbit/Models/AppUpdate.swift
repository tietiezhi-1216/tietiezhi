//  AppUpdate.swift
//  Types shared by the GitHub Releases updater and the Settings UI.

import Foundation

struct AppUpdate: Identifiable, Equatable {
    var id: String { tagName }

    let version: String
    let tagName: String
    let title: String
    let releaseNotes: String
    let releaseURL: URL
    let assetName: String
    let assetSize: Int64
    let downloadURL: URL
    let checksumURL: URL
    let isPrerelease: Bool

    var displayTitle: String {
        title.isEmpty ? "Orbit \(version)" : title
    }
}

enum UpdateStatus: Equatable {
    case idle
    case checking
    case upToDate(version: String)
    case available(AppUpdate)
    case downloading(AppUpdate, progress: Double)
    case downloaded(AppUpdate, fileURL: URL)
    case failed(String)

    var isBusy: Bool {
        switch self {
        case .checking, .downloading:
            return true
        case .idle, .upToDate, .available, .downloaded, .failed:
            return false
        }
    }
}
