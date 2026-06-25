//  TextInserter.swift
//  Deliver the final text into whatever app has focus. Instead of synthesizing
//  the text key-by-key (slow and flaky for CJK / IME), we put it on the
//  pasteboard, synthesize ⌘V, then restore the previous clipboard.
//
//  Synthesizing a keystroke INTO ANOTHER APP requires Accessibility permission —
//  without it the event is silently dropped, so the paste never lands. We gate on
//  that here and report whether the paste was actually attempted, letting the
//  caller fall back to a manual-copy affordance (the Typeless-style "已复制").

import AppKit
import ApplicationServices

enum TextInserter {

    /// Whether we're trusted to post synthetic keystrokes into other apps.
    static var canAutoInsert: Bool {
        Permissions.accessibility == .granted
    }

    /// Whether the system's currently-focused UI element is an editable text
    /// field — i.e. there's a cursor to paste into. Used to decide auto-insert vs
    /// parking the result in the result stack. Requires Accessibility (returns
    /// false without it, so results fall back to the manual queue).
    static func isEditableFieldFocused() -> Bool {
        guard canAutoInsert else { return false }
        guard let element = focusedElement() else {
            // The app exposes NO focused element to Accessibility at all — true for
            // terminal/TUI apps and AX-disabled Electron builds (we saw exactly this
            // for Codex). We can't detect a field here, so do what Typeless / Wispr
            // and friends do everywhere: just paste at the caret and trust the user
            // had one. (Apps that DO expose AX still get the smart "park when the
            // field isn't focused" path above.) Downside: an app that's both AX-blind
            // AND has no field pastes into the void — but the text is kept in history.
            return true
        }
        return elementLooksEditable(element)
    }

    /// The focused UI element of the frontmost app. Tries the system-wide focus
    /// first (works for native apps); if that comes back empty — common for
    /// Electron / Chromium apps, which build their AX tree lazily — falls back to
    /// the app element by PID after asking it to expose one.
    private static func focusedElement() -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
           let f = focused, CFGetTypeID(f) == AXUIElementGetTypeID() {
            return (f as! AXUIElement)
        }
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return nil }
        let appElement = AXUIElementCreateApplication(pid)
        // Nudge Electron/Chromium to build & expose its accessibility tree.
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        var appFocused: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &appFocused) == .success,
           let f = appFocused, CFGetTypeID(f) == AXUIElementGetTypeID() {
            return (f as! AXUIElement)
        }
        return nil
    }

    /// Wake the frontmost app's accessibility tree at record start. Electron /
    /// Chromium apps build their AX tree lazily — the FIRST `kAXFocusedUIElement`
    /// query comes back empty (we saw exactly this for Claude). Setting
    /// `AXManualAccessibility` now means that by delivery (seconds later, after
    /// ASR + polish) the focused-element query resolves the real field, so the
    /// first dictation into an Electron app auto-inserts like every later one.
    static func primeFocusedAppAccessibility() {
        guard canAutoInsert,
              let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    /// Decide whether a focused AX element is something we can paste a caret into.
    /// Three independent signals, any of which is enough — native fields rarely
    /// need more than the role check, but web / Electron / terminal editors
    /// (contentEditable, custom roles) only reveal themselves through the latter
    /// two, which is why the old role-only gate parked their results.
    private static func elementLooksEditable(_ element: AXUIElement) -> Bool {
        var roleCF: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleCF)
        let role = (roleCF as? String) ?? ""
        // Definite text-entry roles — focused native fields and (after we prime
        // AXManualAccessibility) focused Chromium/Electron editables both report one
        // of these. This is the reliable signal that a caret is actually in a field.
        let editableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
        if editableRoles.contains(role) { return true }

        // For a GENERIC role, require BOTH a settable value AND a selected-text
        // range. A container (AXGroup / AXWebArea) reports a document-level selRange
        // even when focus has left the field — but its value isn't settable, so the
        // pair no longer mistakes "no field focused" for "caret is here".
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        return settable.boolValue && hasAttribute(element, kAXSelectedTextRangeAttribute)
    }

    /// Whether `element` exposes `attribute` at all (the value itself is ignored).
    private static func hasAttribute(_ element: AXUIElement, _ attribute: String) -> Bool {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success && value != nil
    }

    /// Put text on the general pasteboard so it can be pasted manually.
    static func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    /// Awaitable paste: set the clipboard, synthesize ⌘V, restore the clipboard —
    /// and only return once the whole cycle is done. The result queue awaits this
    /// so concurrent deliveries never clobber each other's clipboard (pastes run
    /// strictly one at a time). Returns false without trying if Accessibility is
    /// missing.
    @MainActor
    @discardableResult
    static func insertAwaiting(_ text: String) async -> Bool {
        guard !text.isEmpty, canAutoInsert else { return false }
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        try? await Task.sleep(nanoseconds: 80_000_000)
        pasteCommandV()
        try? await Task.sleep(nanoseconds: 600_000_000)
        pasteboard.clearContents()
        if let previous { pasteboard.setString(previous, forType: .string) }
        return true
    }

    /// Try to paste `text` into the focused app. Returns `false` *without
    /// attempting* when Accessibility isn't granted (the keystroke would be
    /// dropped) — the caller should then surface a manual-copy fallback.
    @discardableResult
    static func insert(_ text: String) -> Bool {
        guard !text.isEmpty, canAutoInsert else { return false }

        let pasteboard = NSPasteboard.general
        let previous = pasteboard.string(forType: .string)
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        // Give the pasteboard a beat to settle, then synthesize ⌘V. The pill is a
        // non-activating panel, so focus is still in the user's target app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
            pasteCommandV()
            // Restore the user's clipboard once the paste has been read.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                pasteboard.clearContents()
                if let previous { pasteboard.setString(previous, forType: .string) }
            }
        }
        return true
    }

    /// Synthesize a ⌘V keystroke at the HID level.
    private static func pasteCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let vKey: CGKeyCode = 9   // ANSI 'v'

        let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
        down?.flags = .maskCommand
        let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        up?.flags = .maskCommand

        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}
