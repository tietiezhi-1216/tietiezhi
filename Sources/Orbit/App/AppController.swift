//  AppController.swift
//  The app "brain" the UI talks to for actions and live status. Owns the
//  settings store and (wired up in the dictation layer) the hotkey monitor and
//  dictation engine. Published properties drive the Settings UI.

import Foundation
import AppKit
import Combine

@MainActor
final class AppController: ObservableObject {
    let store: SettingsStore

    /// True while we're listening for the next keypress to bind as the hotkey.
    @Published var capturingHotkey = false
    @Published var micPermission: PermissionState = .notDetermined
    @Published var axPermission: PermissionState = .notDetermined
    @Published var audioInputs: [String] = []

    /// Drives the settings sheet presented inside the chat window.
    @Published var settingsPresented = false

    /// Set by the dictation layer once it's constructed (avoids a hard
    /// compile-time dependency from the UI on the engine).
    var onBeginHotkeyCapture: (() -> Void)?
    var onCancelHotkeyCapture: (() -> Void)?
    var onToggleDictation: (() -> Void)?

    private var cancellables = Set<AnyCancellable>()

    init(store: SettingsStore) {
        self.store = store
        refreshStatus()
    }

    func refreshStatus() {
        micPermission = Permissions.microphone
        axPermission = Permissions.accessibility
        audioInputs = AudioDevices.inputNames()
    }

    // MARK: Permissions

    func requestMicrophone() {
        Permissions.requestMicrophone { [weak self] _ in self?.refreshStatus() }
    }

    func requestAccessibility() {
        Permissions.promptAccessibility()
        // The grant happens in System Settings; re-check shortly after.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refreshStatus()
        }
    }

    // MARK: Hotkey capture

    func beginHotkeyCapture() {
        capturingHotkey = true
        onBeginHotkeyCapture?()
    }

    func cancelHotkeyCapture() {
        capturingHotkey = false
        onCancelHotkeyCapture?()
    }

    /// Called by the hotkey monitor when a key is captured.
    func finishHotkeyCapture(keycode: String) {
        store.settings.hotkey = keycode
        capturingHotkey = false
    }

    func toggleDictation() {
        onToggleDictation?()
    }
}
