//  ShortcutRunner.swift
//  Executes the action bound to a user shortcut. Runs on the main actor because
//  every path touches AppKit (`NSWorkspace`). All work is fire-and-forget: a
//  shortcut should feel instant and never block the tap's dispatch back to main.

import AppKit

@MainActor
enum ShortcutRunner {
    static func run(_ shortcut: ActionShortcut) {
        let target = shortcut.target.trimmed
        guard !target.isEmpty else { return }
        switch shortcut.actionKind {
        case .openApp:     openApp(atPath: target)
        case .openTarget:  openTarget(target)
        case .runCommand:  runCommand(target)
        }
    }

    // MARK: - Actions

    private static func openApp(atPath path: String) {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            if let error {
                NSLog("[shortcut] 打开应用失败：\(path) — \(error.localizedDescription)")
            }
        }
    }

    /// A web/scheme URL opens as a URL; anything else is treated as a file path.
    private static func openTarget(_ target: String) {
        if let url = URL(string: target), let scheme = url.scheme, !scheme.isEmpty,
           !target.hasPrefix("/"), !target.hasPrefix("~") {
            NSWorkspace.shared.open(url)
            return
        }
        let fileURL = URL(fileURLWithPath: (target as NSString).expandingTildeInPath)
        NSWorkspace.shared.open(fileURL)
    }

    /// Run a shell command line detached via a login shell, so `$PATH` and user
    /// aliases from the profile are available (e.g. Homebrew binaries).
    private static func runCommand(_ command: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        do {
            try process.run()
        } catch {
            NSLog("[shortcut] 运行命令失败：\(command) — \(error.localizedDescription)")
        }
    }
}
