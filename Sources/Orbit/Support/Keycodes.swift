//  Keycodes.swift
//  Human-readable labels for the macOS virtual keycodes. Two uses:
//   1. `labels` — the small set of single keys bindable as the dictation hotkey.
//   2. `keyLabel(for:)` — a full ANSI map so a user-defined shortcut chord can
//      render its main key (e.g. keycode 40 → "K", 49 → "Space").

import Foundation

enum Keycodes {
    static let labels: [String: String] = [
        "54": "右 ⌘", "55": "左 ⌘",
        "59": "左 ⌃", "62": "右 ⌃",
        "56": "左 ⇧", "60": "右 ⇧",
        "58": "左 ⌥", "61": "右 ⌥",
        "63": "Fn",
        "49": "空格", "36": "回车", "53": "Esc",
        "48": "Tab", "51": "删除", "57": "大写锁定",
    ]

    static func label(for code: String) -> String {
        if code.isEmpty { return "—" }
        return labels[code] ?? "键码 \(code)"
    }

    /// Virtual keycode → the printed key label used inside a shortcut chord.
    /// Covers the ANSI letters, digits, punctuation and the common named keys.
    static let keyNames: [Int: String] = [
        // Letters (ANSI layout).
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C",
        9: "V", 11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T",
        31: "O", 32: "U", 34: "I", 35: "P", 37: "L", 38: "J", 40: "K", 45: "N",
        46: "M",
        // Digit row.
        18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
        26: "7", 27: "-", 28: "8", 29: "0",
        // Punctuation.
        30: "]", 33: "[", 39: "'", 41: ";", 42: "\\", 43: ",", 44: "/", 47: ".",
        50: "`",
        // Named / whitespace / editing keys.
        36: "↩", 48: "⇥", 49: "Space", 51: "⌫", 53: "⎋", 76: "⌤", 71: "⌧",
        117: "⌦",
        // Arrows.
        123: "←", 124: "→", 125: "↓", 126: "↑",
        // Navigation cluster.
        115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
        // Function row.
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6",
        98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
    ]

    /// Chord-key label for a virtual keycode; falls back to a stable "键\(code)".
    static func keyLabel(for code: Int) -> String {
        keyNames[code] ?? "键\(code)"
    }
}
