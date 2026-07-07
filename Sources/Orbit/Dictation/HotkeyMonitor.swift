//  HotkeyMonitor.swift
//  Global hotkey listener via a macOS CGEventTap, on its own thread + run loop.
//
//  We read ONLY the integer keycode from each event (never converting it to a
//  string), so a single right-⌘ (keycode 54) or any other key toggles dictation,
//  and "learn a key" capture works. Needs Accessibility / Input Monitoring
//  permission; without it the tap simply fails to install (logged, no crash).

import AppKit
import Combine

final class HotkeyMonitor {
    /// Reports the keycode captured in "learn a key" mode.
    var onCaptured: ((String) -> Void)?
    /// Fires when the bound hotkey goes DOWN (press). The gesture state machine
    /// (hold vs double-tap) lives in the engine, so the monitor only reports the
    /// raw key transitions.
    var onHotkeyDown: (() -> Void)?
    /// Fires when the bound hotkey comes UP (release).
    var onHotkeyUp: (() -> Void)?
    /// Fires when Esc is pressed, used to dismiss/cancel the dictation overlay.
    var onEscape: (() -> Void)?
    /// Fires (on the main thread) when a bound shortcut chord matches. The matched
    /// event is swallowed so the focused app never sees it.
    var onShortcut: ((ActionShortcut) -> Void)?
    /// Fires (on the main thread) with the feature id when a BUILT-IN feature
    /// chord matches (screenshot / pin — see `setFeatureChords`). Swallowed
    /// like user shortcuts.
    var onFeatureChord: ((String) -> Void)?
    /// Reports (on the main thread) whether the global event tap actually
    /// installed. `false` means Input Monitoring isn't effective yet — typically
    /// the grant only takes hold after a relaunch.
    var onInstallResult: ((Bool) -> Void)?

    private var capturing = false
    private var hotkey: String
    private var pressed = Set<Int64>()

    /// Shortcut state shared with the tap thread — guarded by `shortcutsLock`
    /// since it's written from the main thread (Combine) and read on the tap.
    private let shortcutsLock = NSLock()
    private var shortcuts: [ActionShortcut] = []
    private var featureChords: [(id: String, keyCode: Int, modifiers: KeyModifiers)] = []
    private var shortcutsSuspended = false

    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var thread: Thread?
    private var cancellable: AnyCancellable?
    private var shortcutsCancellable: AnyCancellable?
    private var captureCancellable: AnyCancellable?

    init(store: SettingsStore) {
        hotkey = store.settings.hotkey
        setShortcuts(store.settings.shortcuts)
        setCaptureChords(store.settings.capture)
        cancellable = store.hotkeyDidChange.sink { [weak self] code in
            self?.hotkey = code
        }
        // Re-read the shortcut list whenever it changes (deduped so unrelated
        // settings edits don't churn the tap thread's snapshot).
        shortcutsCancellable = store.$settings
            .map(\.shortcuts)
            .removeDuplicates()
            .sink { [weak self] list in self?.setShortcuts(list) }
        captureCancellable = store.$settings
            .map(\.capture)
            .removeDuplicates()
            .sink { [weak self] capture in self?.setCaptureChords(capture) }
    }

    func beginCapture() { capturing = true }
    func cancelCapture() { capturing = false }

    /// Replace the matched-shortcut snapshot (only valid, enabled bindings).
    func setShortcuts(_ list: [ActionShortcut]) {
        shortcutsLock.lock()
        shortcuts = list.filter { $0.enabled && $0.isValid }
        shortcutsLock.unlock()
    }

    /// Replace the built-in feature chords (screenshot / pin) from settings.
    func setCaptureChords(_ capture: CaptureSettings) {
        shortcutsLock.lock()
        featureChords = [
            ("capture", capture.captureChord.keyCode, capture.captureChord.modifiers),
            ("pin", capture.pinChord.keyCode, capture.pinChord.modifiers),
        ].filter { !$0.2.isEmpty }
        shortcutsLock.unlock()
        NSLog("[capture] 已加载功能热键: 截图=\(capture.captureChord.display) 贴图=\(capture.pinChord.display)")
    }

    /// Pause / resume chord matching — used while the settings recorder is
    /// listening, so re-pressing an already-bound chord reaches the recorder
    /// (and doesn't fire its action) instead of being swallowed here.
    func suspendShortcutMatching() {
        shortcutsLock.lock(); shortcutsSuspended = true; shortcutsLock.unlock()
    }
    func resumeShortcutMatching() {
        shortcutsLock.lock(); shortcutsSuspended = false; shortcutsLock.unlock()
    }

    /// The bound shortcut matching this key event, if any (thread-safe).
    private func matchedShortcut(code: Int64, flags: CGEventFlags) -> ActionShortcut? {
        let mods = KeyModifiers(cgFlags: flags)
        guard !mods.isEmpty else { return nil }
        shortcutsLock.lock(); defer { shortcutsLock.unlock() }
        guard !shortcutsSuspended else { return nil }
        return shortcuts.first { $0.keyCode == Int(code) && $0.modifiers == mods }
    }

    /// The built-in feature chord matching this key event, if any (thread-safe).
    private func matchedFeature(code: Int64, flags: CGEventFlags) -> String? {
        let mods = KeyModifiers(cgFlags: flags)
        guard !mods.isEmpty else { return nil }
        shortcutsLock.lock(); defer { shortcutsLock.unlock() }
        guard !shortcutsSuspended else { return nil }
        return featureChords.first { $0.keyCode == Int(code) && $0.modifiers == mods }?.id
    }

    func start() {
        guard thread == nil else { return }   // idempotent — never stack taps
        let thread = Thread { [weak self] in self?.runTap() }
        thread.name = "com.orbit.hotkey"
        self.thread = thread
        thread.start()
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
    }

    // MARK: - Tap thread

    private func runTap() {
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue)
                 | (CGEventMask(1) << CGEventType.keyUp.rawValue)
                 | (CGEventMask(1) << CGEventType.flagsChanged.rawValue)

        // An ACTIVE tap (.defaultTap) — even though we never modify events, just
        // forward them — is gated on Accessibility, NOT Input Monitoring. A
        // listen-only tap would require Input Monitoring, a separate grant that's
        // both easy to miss and unreliable to query for a self-signed dev build.
        // Since we already need Accessibility (to paste), this means ONE permission
        // covers both the hotkey and the paste.
        guard let tap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: orbitHotkeyCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            NSLog("[hotkey] 无法安装全局事件监听 — 请在「系统设置 → 隐私与安全性 → 辅助功能」授权 Orbit，然后重启应用。")
            DispatchQueue.main.async { [weak self] in self?.onInstallResult?(false) }
            return
        }
        NSLog("[hotkey] 事件监听已安装（active tap, 依赖辅助功能）")

        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoopSource = source
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        DispatchQueue.main.async { [weak self] in self?.onInstallResult?(true) }
        CFRunLoopRun()
    }

    // MARK: - Event handling (called on the tap thread)

    /// Returns `true` when the event should be swallowed (a matched shortcut).
    fileprivate func handle(type: CGEventType, event: CGEvent) -> Bool {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return false
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        switch type {
        case .keyDown:
            // `insert` is false on auto-repeat (already held).
            let firstPress = pressed.insert(code).inserted
            // A bound chord wins over dictation: fire once, swallow press+repeats
            // so the focused app never receives the keystroke.
            if !capturing, let shortcut = matchedShortcut(code: code, flags: event.flags) {
                if firstPress {
                    DispatchQueue.main.async { [weak self] in self?.onShortcut?(shortcut) }
                }
                return true
            }
            // Built-in feature chords (screenshot / pin) behave the same way.
            if !capturing, let feature = matchedFeature(code: code, flags: event.flags) {
                if firstPress {
                    DispatchQueue.main.async { [weak self] in self?.onFeatureChord?(feature) }
                }
                return true
            }
            // `down` fires exactly once, matching how modifiers behave.
            if firstPress { down(code) }
        case .keyUp:
            if pressed.remove(code) != nil { up(code) }
        case .flagsChanged:
            // Modifiers arrive as FlagsChanged carrying their keycode; the flag
            // set/clear maps to down/up.
            if pressed.contains(code) {
                pressed.remove(code)
                up(code)
            } else {
                pressed.insert(code)
                down(code)
            }
        default:
            break
        }
        return false
    }

    private func down(_ code: Int64) {
        if capturing {
            capturing = false
            DispatchQueue.main.async { [weak self] in self?.onCaptured?(String(code)) }
            return
        }
        if String(code) == hotkey {
            DispatchQueue.main.async { [weak self] in self?.onHotkeyDown?() }
        } else if code == 53 {
            DispatchQueue.main.async { [weak self] in self?.onEscape?() }
        }
    }

    private func up(_ code: Int64) {
        if String(code) == hotkey {
            DispatchQueue.main.async { [weak self] in self?.onHotkeyUp?() }
        }
    }
}

/// C-compatible tap callback: recover the monitor from `refcon` and dispatch.
private func orbitHotkeyCallback(
    _ proxy: CGEventTapProxy,
    _ type: CGEventType,
    _ event: CGEvent,
    _ refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if let refcon {
        let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
        if monitor.handle(type: type, event: event) {
            return nil   // swallow a matched shortcut chord
        }
    }
    return Unmanaged.passUnretained(event)
}
