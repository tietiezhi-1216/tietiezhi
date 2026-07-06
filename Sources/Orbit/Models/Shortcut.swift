//  Shortcut.swift
//  User-defined global keyboard shortcuts: a modifier+key combo bound to an
//  action (open an app, open a file/URL, run a shell command). Distinct from the
//  dictation `hotkey` (a single modifier key) — these are full chords the global
//  event tap matches and swallows (see HotkeyMonitor), and they fire regardless
//  of which app is focused. `⌃ + <letter>` is the recommended shape: rarely
//  claimed by macOS or other apps.
//
//  Persisted inside `Settings` as JSON; decoding stays tolerant of missing /
//  older fields so the array survives schema growth.

import Foundation
import AppKit

// MARK: - Modifiers

/// The four chord modifiers, stored as a stable bitmask so the JSON is a plain
/// integer and never depends on AppKit's flag layout.
struct KeyModifiers: OptionSet, Hashable, Codable {
    let rawValue: Int
    init(rawValue: Int) { self.rawValue = rawValue }

    static let control = KeyModifiers(rawValue: 1 << 0)
    static let option  = KeyModifiers(rawValue: 1 << 1)
    static let shift   = KeyModifiers(rawValue: 1 << 2)
    static let command = KeyModifiers(rawValue: 1 << 3)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        rawValue = try c.decode(Int.self)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }

    /// From a live keyDown / flagsChanged event on the tap thread.
    init(cgFlags: CGEventFlags) {
        var m = KeyModifiers()
        if cgFlags.contains(.maskControl)   { m.insert(.control) }
        if cgFlags.contains(.maskAlternate) { m.insert(.option) }
        if cgFlags.contains(.maskShift)     { m.insert(.shift) }
        if cgFlags.contains(.maskCommand)   { m.insert(.command) }
        self = m
    }

    /// From an `NSEvent` in the recorder control.
    init(nsFlags: NSEvent.ModifierFlags) {
        var m = KeyModifiers()
        if nsFlags.contains(.control) { m.insert(.control) }
        if nsFlags.contains(.option)  { m.insert(.option) }
        if nsFlags.contains(.shift)   { m.insert(.shift) }
        if nsFlags.contains(.command) { m.insert(.command) }
        self = m
    }

    /// Symbols in macOS canonical order: ⌃⌥⇧⌘.
    var symbols: String {
        var s = ""
        if contains(.control) { s += "⌃" }
        if contains(.option)  { s += "⌥" }
        if contains(.shift)   { s += "⇧" }
        if contains(.command) { s += "⌘" }
        return s
    }
}

// MARK: - Action

/// What a shortcut does when triggered. A `kind` + a single free-form `target`
/// string keeps the model flat and Codable (mirrors `MCPServerConfig`'s shape).
enum ShortcutActionKind: String, Codable, CaseIterable, Identifiable, Hashable {
    case openApp      // target = /Applications/X.app (a bundle path)
    case openTarget   // target = a URL (https://…, mailto:…) or a file/folder path
    case runCommand   // target = a shell command line (/bin/zsh -lc)

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .openApp:     return "打开应用"
        case .openTarget:  return "打开文件 / 网址"
        case .runCommand:  return "运行命令"
        }
    }

    var symbol: String {
        switch self {
        case .openApp:     return "app.dashed"
        case .openTarget:  return "link"
        case .runCommand:  return "terminal"
        }
    }

    /// Placeholder text for the target field in the editor.
    var targetPrompt: String {
        switch self {
        case .openApp:     return "选择一个应用…"
        case .openTarget:  return "https://example.com 或 /Users/you/Documents"
        case .runCommand:  return "例如：open -a Terminal 或 osascript -e '…'"
        }
    }
}

// MARK: - Shortcut

/// One user binding: a chord (`modifiers` + `keyCode`) → an action.
struct ActionShortcut: Identifiable, Codable, Hashable {
    var id: String
    /// macOS virtual keycode of the non-modifier key (e.g. 40 = K).
    var keyCode: Int
    var modifiers: KeyModifiers
    var actionKind: ShortcutActionKind
    /// App bundle path / URL / file path / command, per `actionKind`.
    var target: String
    /// Friendly name shown in the list — the app's display name for `openApp`,
    /// otherwise a user-editable label (falls back to the target).
    var label: String
    var enabled: Bool

    init(id: String = UUID().uuidString,
         keyCode: Int = 0,
         modifiers: KeyModifiers = [],
         actionKind: ShortcutActionKind = .openApp,
         target: String = "",
         label: String = "",
         enabled: Bool = true) {
        self.id = id
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.actionKind = actionKind
        self.target = target
        self.label = label
        self.enabled = enabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        keyCode = try c.decodeIfPresent(Int.self, forKey: .keyCode) ?? 0
        modifiers = try c.decodeIfPresent(KeyModifiers.self, forKey: .modifiers) ?? []
        actionKind = try c.decodeIfPresent(ShortcutActionKind.self, forKey: .actionKind) ?? .openApp
        target = try c.decodeIfPresent(String.self, forKey: .target) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }

    /// A binding is usable only with a real key and at least one modifier — a
    /// bare letter would swallow ordinary typing.
    var isValid: Bool {
        !modifiers.isEmpty && keyCode >= 0 && !target.trimmed.isEmpty
    }

    /// `⌃K`-style rendering of the chord.
    var comboDisplay: String {
        modifiers.symbols + Keycodes.keyLabel(for: keyCode)
    }

    /// Best label to show for this binding.
    var displayLabel: String {
        let l = label.trimmed
        if !l.isEmpty { return l }
        let t = target.trimmed
        if actionKind == .openApp {
            return (t as NSString).lastPathComponent
                .replacingOccurrences(of: ".app", with: "")
        }
        return t.isEmpty ? actionKind.displayName : t
    }
}
