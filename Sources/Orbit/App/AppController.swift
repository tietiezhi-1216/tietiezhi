//  AppController.swift
//  The app "brain" the UI talks to for actions and live status. Owns the
//  settings store and (wired up in the dictation layer) the hotkey monitor and
//  dictation engine. Published properties drive the Settings UI.

import Foundation
import AppKit
import Combine

enum OrbitWorkspace {
    case chat
    case creation
    case settings
}

/// Which design surface the 创作 workspace shows.
enum CreationTab {
    case image
    case video
}

@MainActor
final class AppController: ObservableObject {
    let store: SettingsStore

    /// Main-window workspace selection. Settings are shown in-window, not as a
    /// sheet or a separate window.
    @Published var workspace: OrbitWorkspace = .chat
    @Published var settingsSection: SettingsSection = .providers
    @Published var creationTab: CreationTab = .image

    /// True while we're listening for the next keypress to bind as the hotkey.
    @Published var capturingHotkey = false
    @Published var micPermission: PermissionState = .notDetermined
    @Published var axPermission: PermissionState = .notDetermined
    @Published var inputMonitoringPermission: PermissionState = .notDetermined
    @Published var screenRecordingPermission: PermissionState = .notDetermined
    @Published var audioInputs: [String] = []
    @Published var updateStatus: UpdateStatus = .idle

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

    /// True while a settings shortcut recorder is listening — pauses global chord
    /// matching so an already-bound chord reaches the recorder.
    @Published var isRecordingShortcut = false

    /// Set by the dictation layer once it's constructed (avoids a hard
    /// compile-time dependency from the UI on the engine).
    var onBeginHotkeyCapture: (() -> Void)?
    var onCancelHotkeyCapture: (() -> Void)?
    var onToggleDictation: (() -> Void)?
    /// Wired to the capture engine (screenshot satellite).
    var onStartCapture: (() -> Void)?
    var onPinClipboard: (() -> Void)?
    var onPinImage: ((NSImage) -> Void)?
    /// Wired to the hotkey monitor to gate chord matching while recording.
    var onSuspendShortcuts: (() -> Void)?
    var onResumeShortcuts: (() -> Void)?

    private var updateTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    init(store: SettingsStore) {
        self.store = store
        refreshStatus()
    }

    func refreshStatus() {
        micPermission = Permissions.microphone
        axPermission = Permissions.accessibility
        inputMonitoringPermission = Permissions.inputMonitoring
        screenRecordingPermission = Permissions.screenRecording
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

    func openCreationWorkspace(_ tab: CreationTab = .image) {
        creationTab = tab
        workspace = .creation
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

    // MARK: Screenshot satellite

    /// 区域截图 (from settings / menus). A short delay lets the invoking UI
    /// (menu, settings window) dismiss before the screen freezes.
    func startCapture(afterDelay seconds: TimeInterval = 0.25) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            self?.onStartCapture?()
        }
    }

    func pinClipboard() {
        onPinClipboard?()
    }

    func pinImage(_ image: NSImage) {
        onPinImage?(image)
    }

    func requestScreenRecording() {
        Permissions.requestScreenRecording()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refreshStatus()
        }
    }

    // MARK: Shortcut recording

    /// The settings recorder is now listening — mute global chord matching.
    func beginShortcutRecording() {
        guard !isRecordingShortcut else { return }
        isRecordingShortcut = true
        onSuspendShortcuts?()
    }

    /// Recording finished (captured or cancelled) — restore chord matching.
    func endShortcutRecording() {
        guard isRecordingShortcut else { return }
        isRecordingShortcut = false
        onResumeShortcuts?()
    }

    // MARK: Software updates

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    var currentBuild: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }

    var currentArchitecture: String {
        GitHubUpdater.currentArchitecture
    }

    func checkForUpdates() {
        updateTask?.cancel()
        updateStatus = .checking

        let currentVersion = self.currentVersion
        let architecture = self.currentArchitecture
        updateTask = Task { [weak self] in
            guard let self else { return }
            do {
                let update = try await GitHubUpdater.checkForUpdate(
                    currentVersion: currentVersion,
                    architecture: architecture
                )
                guard !Task.isCancelled else { return }
                updateStatus = update.map(UpdateStatus.available) ?? .upToDate(version: currentVersion)
            } catch {
                guard !Task.isCancelled else { return }
                updateStatus = .failed(error.localizedDescription)
            }
        }
    }

    func downloadAndOpenUpdate(_ update: AppUpdate) {
        updateTask?.cancel()
        updateStatus = .downloading(update, progress: 0)

        updateTask = Task { [weak self] in
            guard let self else { return }
            do {
                let fileURL = try await GitHubUpdater.downloadAndVerify(update) { progress in
                    Task { @MainActor [weak self] in
                        guard let self, !Task.isCancelled else { return }
                        updateStatus = .downloading(update, progress: progress)
                    }
                }
                guard !Task.isCancelled else { return }
                updateStatus = .downloaded(update, fileURL: fileURL)
                NSWorkspace.shared.open(fileURL)
            } catch {
                guard !Task.isCancelled else { return }
                updateStatus = .failed(error.localizedDescription)
            }
        }
    }

    func openReleasePage(_ url: URL = GitHubUpdater.releasesPage) {
        NSWorkspace.shared.open(url)
    }

    func openDownloadedUpdate(_ fileURL: URL) {
        NSWorkspace.shared.open(fileURL)
    }
}
