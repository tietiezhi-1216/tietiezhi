//  CaptureSettings.swift
//  Persisted configuration for the screenshot satellite (区域截图 / 贴图).
//  Lives inside `Settings` as one Codable sub-document; decoding is tolerant of
//  missing fields so old configs upgrade silently (see Settings.init(from:)).

import Foundation

/// A modifier+key chord bound to a BUILT-IN feature (screenshot / pin). Unlike
/// `ActionShortcut` — user-defined bindings to arbitrary actions — the feature
/// is fixed and only the chord is rebindable, so this stays a plain pair.
struct KeyChord: Codable, Hashable {
    /// macOS virtual keycode of the non-modifier key.
    var keyCode: Int
    var modifiers: KeyModifiers

    /// A chord is usable only with at least one modifier — a bare letter would
    /// swallow ordinary typing (same rule as ActionShortcut).
    var isValid: Bool { !modifiers.isEmpty && keyCode >= 0 }

    /// `⌃⇧A`-style rendering.
    var display: String { modifiers.symbols + Keycodes.keyLabel(for: keyCode) }

    init(keyCode: Int, modifiers: KeyModifiers) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        keyCode = try c.decodeIfPresent(Int.self, forKey: .keyCode) ?? 0
        modifiers = try c.decodeIfPresent(KeyModifiers.self, forKey: .modifiers) ?? []
    }
}

struct CaptureSettings: Codable, Hashable {
    /// 区域截图 chord. Default ⌃⇧A (微信/QQ 用户的肌肉记忆).
    var captureChord: KeyChord
    /// 剪贴板贴图 chord. Default ⌃⇧P (P = Pin).
    var pinChord: KeyChord
    /// Put the final image on the pasteboard when the user hits 完成/复制.
    var copyAfterCapture: Bool
    /// Show the bottom-left floating thumbnail after a capture finishes.
    var showQuickPreview: Bool

    static let defaults = CaptureSettings(
        captureChord: KeyChord(keyCode: 0, modifiers: [.control, .shift]),   // ⌃⇧A
        pinChord: KeyChord(keyCode: 35, modifiers: [.control, .shift]),      // ⌃⇧P
        copyAfterCapture: true,
        showQuickPreview: true
    )

    init(captureChord: KeyChord, pinChord: KeyChord,
         copyAfterCapture: Bool, showQuickPreview: Bool) {
        self.captureChord = captureChord
        self.pinChord = pinChord
        self.copyAfterCapture = copyAfterCapture
        self.showQuickPreview = showQuickPreview
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = CaptureSettings.defaults
        captureChord = try c.decodeIfPresent(KeyChord.self, forKey: .captureChord) ?? d.captureChord
        pinChord = try c.decodeIfPresent(KeyChord.self, forKey: .pinChord) ?? d.pinChord
        copyAfterCapture = try c.decodeIfPresent(Bool.self, forKey: .copyAfterCapture) ?? d.copyAfterCapture
        showQuickPreview = try c.decodeIfPresent(Bool.self, forKey: .showQuickPreview) ?? d.showQuickPreview
    }
}
