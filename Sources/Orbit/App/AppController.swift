//  AppController.swift
//  The app "brain" the UI talks to for actions and live status. Owns the
//  settings store and (wired up in the dictation layer) the hotkey monitor and
//  dictation engine. Published properties drive the Settings UI.

import Foundation
import AppKit
import Combine

enum OrbitWorkspace {
    case chat
    case settings
}

@MainActor
final class AppController: ObservableObject {
    let store: SettingsStore

    /// Main-window workspace selection. Settings are shown in-window, not as a
    /// sheet or a separate window.
    @Published var workspace: OrbitWorkspace = .chat
    @Published var settingsSection: SettingsSection = .providers

    /// True while we're listening for the next keypress to bind as the hotkey.
    @Published var capturingHotkey = false
    @Published var micPermission: PermissionState = .notDetermined
    @Published var axPermission: PermissionState = .notDetermined
    @Published var inputMonitoringPermission: PermissionState = .notDetermined
    @Published var audioInputs: [String] = []

    /// The two grants dictation truly can't work without: record (mic) and paste
    /// the result (accessibility). Input Monitoring is intentionally NOT required
    /// here — on current macOS the global hotkey's listen-only event tap installs
    /// under Accessibility, and `IOHIDCheckAccess` is unreliable for our ad-hoc /
    /// self-signed dev identity. Whether the hotkey actually works is decided by
    /// whether the tap installs (HotkeyMonitor.onInstallResult), not by this flag.
    var requiredPermissionsGranted: Bool {
        micPermission == .granted && axPermission == .granted
    }

    /// Fired once, when polling first sees the required permissions granted (used
    /// by the onboarding gate to hand off to the main window + start the hotkey).
    var onPermissionsSatisfied: (() -> Void)?
    private var pollTask: Task<Void, Never>?

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
        inputMonitoringPermission = Permissions.inputMonitoring
        audioInputs = AudioDevices.inputNames()
    }

    /// Re-check permissions once a second until all three are granted, then fire
    /// `onPermissionsSatisfied`. Drives the onboarding gate's live status so the
    /// user sees grants land (and we advance) without a manual refresh.
    func startPermissionPolling() {
        refreshStatus()
        pollTask?.cancel()
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self else { return }
                self.refreshStatus()
                if self.requiredPermissionsGranted {
                    self.pollTask = nil
                    self.onPermissionsSatisfied?()
                    return
                }
            }
        }
    }

    func stopPermissionPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func openChatWorkspace() {
        workspace = .chat
    }

    func openSettingsWorkspace(_ section: SettingsSection = .providers) {
        refreshStatus()
        settingsSection = section
        workspace = .settings
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

    func requestInputMonitoring() {
        // If still undetermined this shows the system prompt; once decided, macOS
        // only opens System Settings, so re-check shortly after either way.
        Permissions.requestInputMonitoring()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
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
