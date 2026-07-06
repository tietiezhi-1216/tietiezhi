//  SkillStore.swift
//  Discovers user skills on disk. Scans ~/.orbit/skills for subfolders that
//  contain a SKILL.md, parsing each into a `Skill`. Published so the settings UI
//  and the agent editor reflect what's installed; `reload()` re-scans on demand.

import Foundation
import Combine

@MainActor
final class SkillStore: ObservableObject {
    @Published private(set) var skills: [Skill] = []

    /// `~/.orbit/skills` — the global skills directory.
    static var directory: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".orbit/skills", isDirectory: true)
    }

    init() {
        reload()
    }

    /// Create the skills directory if it doesn't exist yet (used before opening it).
    func ensureDirectory() {
        try? FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
    }

    func reload() {
        let fm = FileManager.default
        let root = Self.directory
        guard let entries = try? fm.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]
        ) else {
            skills = []
            return
        }
        var found: [Skill] = []
        for entry in entries {
            let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDir else { continue }
            let md = entry.appendingPathComponent("SKILL.md")
            if fm.fileExists(atPath: md.path), let skill = Skill.parse(markdownAt: md) {
                found.append(skill)
            }
        }
        skills = found.sorted { $0.displayName < $1.displayName }
    }

    func skill(id: String) -> Skill? { skills.first { $0.id == id } }
}
