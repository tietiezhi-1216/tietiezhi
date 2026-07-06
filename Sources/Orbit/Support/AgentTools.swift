//  AgentTools.swift
//  OpenCode / Claude-Code-style local tools the chat agent can call: read, list,
//  find, search, write, edit, and run a command. Two safety rails gate every
//  path:
//    1. A directory whitelist (`Settings.toolRootDirectories`) — a tool refuses
//       any path that doesn't resolve inside an allowed root, and refuses
//       entirely when no root is granted.
//    2. Per-call confirmation — mutating / executing tools (write / edit / run)
//       pop an NSAlert before acting; the user can allow-for-this-session.
//
//  Tools run on the main actor (they present the confirmation there); the actual
//  blocking work (command execution) hops to a background queue so the UI never
//  stalls.

import AppKit

// MARK: - Guard (whitelist + confirmation)

@MainActor
final class ToolGuard {
    private let settings: SettingsStore
    /// Danger categories the user chose to stop being asked about this session.
    private var sessionAllow: Set<String> = []

    init(settings: SettingsStore) {
        self.settings = settings
    }

    private var roots: [URL] {
        settings.settings.toolRootDirectories.map {
            URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath).standardizedFileURL
        }
    }

    var hasRoots: Bool { !roots.isEmpty }

    /// The directory a bare command / relative path is resolved against.
    var defaultRoot: URL? { roots.first }

    /// Resolve a user/model-supplied path and verify it stays inside a granted
    /// root (blocks `..` escapes and absolute paths outside the whitelist).
    func resolve(_ path: String) throws -> URL {
        let roots = self.roots
        guard let first = roots.first else {
            throw OrbitError("未设置工作目录：请在「设置 → 功能 → 工具」里添加至少一个允许访问的目录。")
        }
        let expanded = (path as NSString).expandingTildeInPath
        let url = (expanded.hasPrefix("/")
                   ? URL(fileURLWithPath: expanded)
                   : first.appendingPathComponent(expanded)).standardizedFileURL
        let inside = roots.contains { root in
            url.path == root.path || url.path.hasPrefix(root.path + "/")
        }
        guard inside else {
            throw OrbitError("路径超出允许目录：\(url.path)。可在「设置 → 功能 → 工具」添加该目录。")
        }
        return url
    }

    /// Confirm a dangerous action. `kind` groups the session-suppression (e.g.
    /// all command runs share one "don't ask again").
    func confirm(kind: String, title: String, detail: String) -> Bool {
        if sessionAllow.contains(kind) { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: "允许")
        alert.addButton(withTitle: "拒绝")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "本次会话内不再询问同类操作"
        NSApp.activate(ignoringOtherApps: true)
        let allowed = alert.runModal() == .alertFirstButtonReturn
        if allowed, alert.suppressionButton?.state == .on { sessionAllow.insert(kind) }
        return allowed
    }
}

// MARK: - Shared helpers

private enum AgentToolLimits {
    static let maxReadBytes = 200_000
    static let maxOutputChars = 20_000
    static let maxMatches = 200
    static let maxScanFiles = 8_000
    static let skipDirs: Set<String> = [".git", "node_modules", ".build", "DerivedData", ".next", "dist", "Pods"]
}

private func arg(_ args: [String: Any], _ key: String) -> String? {
    (args[key] as? String)?.trimmed
}

/// Convert a glob (`*`, `**`, `?`) to an anchored regex over a relative path.
private func globToRegex(_ glob: String) -> NSRegularExpression? {
    var re = "^"
    var i = glob.startIndex
    while i < glob.endIndex {
        let c = glob[i]
        switch c {
        case "*":
            let next = glob.index(after: i)
            if next < glob.endIndex, glob[next] == "*" {
                re += ".*"; i = glob.index(after: next); continue
            }
            re += "[^/]*"
        case "?": re += "[^/]"
        case ".", "(", ")", "+", "|", "^", "$", "{", "}", "[", "]", "\\":
            re += "\\" + String(c)
        default: re += String(c)
        }
        i = glob.index(after: i)
    }
    re += "$"
    return try? NSRegularExpression(pattern: re)
}

private func isProbablyText(_ url: URL) -> Bool {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 4096)) ?? Data()
    return !head.contains(0)   // NUL byte ⇒ binary
}

/// Walk files under `root` (skipping noisy build dirs), yielding each until the
/// scan cap is hit.
private func walkFiles(_ root: URL, _ body: (URL) -> Bool) {
    let fm = FileManager.default
    guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey],
                                 options: [.skipsHiddenFiles]) else { return }
    var scanned = 0
    for case let url as URL in en {
        if AgentToolLimits.skipDirs.contains(url.lastPathComponent) {
            en.skipDescendants(); continue
        }
        let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        if isDir { continue }
        scanned += 1
        if scanned > AgentToolLimits.maxScanFiles { break }
        if !body(url) { break }
    }
}

// MARK: - Read

struct ReadFileTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "读取文件" }
    var category: ToolCategory { .file }

    var spec: ToolSpec {
        ToolSpec(name: "read_file",
                 description: "读取本地文本文件的内容（带行号）。用于查看代码或文本。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "path": ["type": "string", "description": "文件路径（相对工作目录或绝对路径）"],
                        "offset": ["type": "integer", "description": "起始行（从 1 开始，可选）"],
                        "limit": ["type": "integer", "description": "读取行数（可选，默认全部/截断）"],
                    ] as [String: Any],
                    "required": ["path"],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let path = arg(arguments, "path"), !path.isEmpty else { throw OrbitError("缺少 path") }
        let url = try policy.resolve(path)
        let data = try Data(contentsOf: url)
        guard !data.contains(0) else { throw OrbitError("这是二进制文件，无法作为文本读取。") }
        let capped = data.count > AgentToolLimits.maxReadBytes
            ? data.prefix(AgentToolLimits.maxReadBytes) : data
        let text = String(decoding: capped, as: UTF8.self)
        var lines = text.components(separatedBy: "\n")
        let start = max(0, (arguments["offset"] as? Int ?? 1) - 1)
        if start > 0 { lines = Array(lines.dropFirst(start)) }
        if let limit = arguments["limit"] as? Int, limit > 0, lines.count > limit {
            lines = Array(lines.prefix(limit))
        }
        let numbered = lines.enumerated()
            .map { "\(start + $0.offset + 1)\t\($0.element)" }
            .joined(separator: "\n")
        let note = data.count > AgentToolLimits.maxReadBytes ? "\n…（文件过大，已截断）" : ""
        return ToolOutput(content: numbered.isEmpty ? "(空文件)" : numbered + note)
    }
}

// MARK: - List

struct ListDirTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "列目录" }
    var category: ToolCategory { .file }

    var spec: ToolSpec {
        ToolSpec(name: "list_dir",
                 description: "列出目录下的文件与子目录。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "path": ["type": "string", "description": "目录路径（默认工作目录根）"],
                    ] as [String: Any],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        let url = try policy.resolve(arg(arguments, "path") ?? ".")
        let fm = FileManager.default
        let items = try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey],
                                               options: [.skipsHiddenFiles])
        let lines = items.sorted { $0.lastPathComponent < $1.lastPathComponent }.map { item -> String in
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            return isDir ? item.lastPathComponent + "/" : item.lastPathComponent
        }
        return ToolOutput(content: lines.isEmpty ? "(空目录)" : lines.joined(separator: "\n"))
    }
}

// MARK: - Find

struct FindFilesTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "查找文件" }
    var category: ToolCategory { .file }

    var spec: ToolSpec {
        ToolSpec(name: "find_files",
                 description: "按通配符查找文件（支持 *、**、?，如 **/*.swift）。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "pattern": ["type": "string", "description": "通配符，如 **/*.swift"],
                        "path": ["type": "string", "description": "搜索根目录（默认工作目录根）"],
                    ] as [String: Any],
                    "required": ["pattern"],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let pattern = arg(arguments, "pattern"), !pattern.isEmpty else { throw OrbitError("缺少 pattern") }
        let root = try policy.resolve(arg(arguments, "path") ?? ".")
        guard let regex = globToRegex(pattern) else { throw OrbitError("通配符无效") }
        var hits: [String] = []
        walkFiles(root) { url in
            let rel = String(url.path.dropFirst(root.path.count).drop(while: { $0 == "/" }))
            let range = NSRange(rel.startIndex..., in: rel)
            if regex.firstMatch(in: rel, range: range) != nil { hits.append(rel) }
            return hits.count < AgentToolLimits.maxMatches
        }
        return ToolOutput(content: hits.isEmpty ? "(无匹配)"
                          : hits.sorted().joined(separator: "\n"))
    }
}

// MARK: - Search (grep)

struct SearchFilesTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "搜索内容" }
    var category: ToolCategory { .file }

    var spec: ToolSpec {
        ToolSpec(name: "search_files",
                 description: "在文件内容中搜索文本或正则，返回匹配的「文件:行 内容」。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "query": ["type": "string", "description": "要搜索的文本或正则"],
                        "path": ["type": "string", "description": "搜索根目录（默认工作目录根）"],
                        "regex": ["type": "boolean", "description": "query 是否为正则（默认否）"],
                    ] as [String: Any],
                    "required": ["query"],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let query = arg(arguments, "query"), !query.isEmpty else { throw OrbitError("缺少 query") }
        let root = try policy.resolve(arg(arguments, "path") ?? ".")
        let useRegex = arguments["regex"] as? Bool ?? false
        let regex = useRegex ? try? NSRegularExpression(pattern: query, options: [.caseInsensitive]) : nil
        if useRegex && regex == nil { throw OrbitError("正则无效") }

        var out: [String] = []
        walkFiles(root) { url in
            guard isProbablyText(url), let text = try? String(contentsOf: url, encoding: .utf8) else { return true }
            let rel = String(url.path.dropFirst(root.path.count).drop(while: { $0 == "/" }))
            for (i, line) in text.components(separatedBy: "\n").enumerated() {
                let match: Bool
                if let regex {
                    match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) != nil
                } else {
                    match = line.localizedCaseInsensitiveContains(query)
                }
                if match {
                    out.append("\(rel):\(i + 1): \(line.trimmed.prefix(200))")
                    if out.count >= AgentToolLimits.maxMatches { return false }
                }
            }
            return true
        }
        let note = out.count >= AgentToolLimits.maxMatches ? "\n…（结果过多，已截断）" : ""
        return ToolOutput(content: out.isEmpty ? "(无匹配)" : out.joined(separator: "\n") + note)
    }
}

// MARK: - Write (dangerous)

struct WriteFileTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "写入文件" }
    var category: ToolCategory { .file }
    var isDangerous: Bool { true }

    var spec: ToolSpec {
        ToolSpec(name: "write_file",
                 description: "创建或覆盖一个文本文件。破坏性操作，执行前会向用户确认。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "path": ["type": "string", "description": "文件路径"],
                        "content": ["type": "string", "description": "写入的完整内容"],
                    ] as [String: Any],
                    "required": ["path", "content"],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let path = arg(arguments, "path"), !path.isEmpty else { throw OrbitError("缺少 path") }
        guard let content = arguments["content"] as? String else { throw OrbitError("缺少 content") }
        let url = try policy.resolve(path)
        let exists = FileManager.default.fileExists(atPath: url.path)
        guard policy.confirm(kind: "write",
                             title: exists ? "覆盖文件？" : "创建文件？",
                             detail: "\(url.path)\n\n约 \(content.count) 个字符。") else {
            throw OrbitError("用户拒绝了写入操作。")
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try content.data(using: .utf8)?.write(to: url, options: .atomic)
        return ToolOutput(content: "{\"status\":\"ok\",\"path\":\"\(url.path)\",\"bytes\":\(content.utf8.count)}")
    }
}

// MARK: - Edit (dangerous)

struct EditFileTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "编辑文件" }
    var category: ToolCategory { .file }
    var isDangerous: Bool { true }

    var spec: ToolSpec {
        ToolSpec(name: "edit_file",
                 description: "把文件中的 old_string 精确替换为 new_string（old_string 必须在文件中唯一出现）。破坏性操作，执行前会向用户确认。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "path": ["type": "string", "description": "文件路径"],
                        "old_string": ["type": "string", "description": "要替换的原文（含足够上下文以保证唯一）"],
                        "new_string": ["type": "string", "description": "替换成的新文本"],
                    ] as [String: Any],
                    "required": ["path", "old_string", "new_string"],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let path = arg(arguments, "path"), !path.isEmpty else { throw OrbitError("缺少 path") }
        guard let oldStr = arguments["old_string"] as? String, !oldStr.isEmpty else { throw OrbitError("缺少 old_string") }
        guard let newStr = arguments["new_string"] as? String else { throw OrbitError("缺少 new_string") }
        let url = try policy.resolve(path)
        let text = try String(contentsOf: url, encoding: .utf8)
        let occurrences = text.components(separatedBy: oldStr).count - 1
        guard occurrences > 0 else { throw OrbitError("在文件中找不到 old_string。") }
        guard occurrences == 1 else { throw OrbitError("old_string 出现了 \(occurrences) 次，不唯一——请提供更多上下文。") }
        guard policy.confirm(kind: "write",
                             title: "编辑文件？",
                             detail: "\(url.path)\n\n将替换一处文本。") else {
            throw OrbitError("用户拒绝了编辑操作。")
        }
        let updated = text.replacingOccurrences(of: oldStr, with: newStr)
        try updated.data(using: .utf8)?.write(to: url, options: .atomic)
        return ToolOutput(content: "{\"status\":\"ok\",\"path\":\"\(url.path)\"}")
    }
}

// MARK: - Run command (dangerous)

struct RunCommandTool: OrbitTool {
    let policy: ToolGuard
    var displayName: String { "执行命令" }
    var category: ToolCategory { .command }
    var isDangerous: Bool { true }

    var spec: ToolSpec {
        ToolSpec(name: "run_command",
                 description: "在工作目录中执行一条 shell 命令并返回输出（stdout+stderr）。高危操作，执行前会向用户确认。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "command": ["type": "string", "description": "要执行的命令行"],
                        "cwd": ["type": "string", "description": "工作目录（默认第一个允许目录）"],
                    ] as [String: Any],
                    "required": ["command"],
                 ])
    }

    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let command = arg(arguments, "command"), !command.isEmpty else { throw OrbitError("缺少 command") }
        let cwd: URL
        if let c = arg(arguments, "cwd"), !c.isEmpty {
            cwd = try policy.resolve(c)
        } else if let root = policy.defaultRoot {
            cwd = root
        } else {
            throw OrbitError("未设置工作目录：请在「设置 → 功能 → 工具」里添加允许访问的目录。")
        }
        guard policy.confirm(kind: "run",
                             title: "执行命令？",
                             detail: "目录：\(cwd.path)\n\n$ \(command)") else {
            throw OrbitError("用户拒绝了命令执行。")
        }
        let (code, output) = await Self.runProcess(command, cwd: cwd)
        let trimmed = output.count > AgentToolLimits.maxOutputChars
            ? String(output.prefix(AgentToolLimits.maxOutputChars)) + "\n…（输出过长，已截断）"
            : output
        return ToolOutput(content: "退出码：\(code)\n\n\(trimmed.isEmpty ? "(无输出)" : trimmed)")
    }

    /// Run the command off the main thread so the UI stays responsive.
    private static func runProcess(_ command: String, cwd: URL) async -> (Int32, String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/zsh")
                process.arguments = ["-lc", command]
                process.currentDirectoryURL = cwd
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe
                do { try process.run() } catch {
                    continuation.resume(returning: (-1, "启动失败：\(error.localizedDescription)")); return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                continuation.resume(returning: (process.terminationStatus,
                                                String(decoding: data, as: UTF8.self)))
            }
        }
    }
}
