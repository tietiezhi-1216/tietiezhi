//  Skill.swift
//  A user-installed "skill": a folder under ~/.orbit/skills containing a
//  SKILL.md. Same shape as Claude Code / Anthropic Agent Skills — YAML-ish
//  frontmatter (name, description) plus a markdown body of instructions. Skills
//  are DISCOVERED from disk (not added through a form); an agent opts into skills
//  by id, and the active agent's enabled skills are folded into its system prompt.
//
//  This is deliberately distinct from tools/MCP: a tool is a function the model
//  calls, a skill is a bundle of instructions (and, optionally, companion files
//  the model can read via the file tools).

import Foundation

struct Skill: Identifiable, Hashable {
    /// The skill folder name (stable id used in `Agent.enabledSkills`).
    let id: String
    let name: String
    let description: String
    /// The SKILL.md body (everything after the frontmatter).
    let instructions: String
    /// The skill's directory on disk.
    let directory: URL

    var displayName: String { name.isEmpty ? id : name }

    /// Parse a `SKILL.md` at `url` whose parent folder is the skill.
    /// Frontmatter is an optional `---`-fenced block of `key: value` lines.
    static func parse(markdownAt url: URL) -> Skill? {
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let dir = url.deletingLastPathComponent()
        let id = dir.lastPathComponent

        var name = ""
        var description = ""
        var body = raw

        let lines = raw.components(separatedBy: "\n")
        if lines.first?.trimmed == "---" {
            var meta: [String: String] = [:]
            var end = -1
            for i in 1..<lines.count where lines[i].trimmed == "---" { end = i; break }
            if end > 0 {
                for i in 1..<end {
                    let parts = lines[i].split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                    guard parts.count == 2 else { continue }
                    let key = String(parts[0]).trimmed.lowercased()
                    let value = String(parts[1]).trimmed
                        .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                    meta[key] = value
                }
                name = meta["name"] ?? ""
                description = meta["description"] ?? ""
                body = lines[(end + 1)...].joined(separator: "\n")
            }
        }

        // Fall back to the folder name / first heading when no frontmatter name.
        if name.isEmpty { name = id }
        return Skill(id: id, name: name, description: description,
                     instructions: body.trimmed, directory: dir)
    }
}
