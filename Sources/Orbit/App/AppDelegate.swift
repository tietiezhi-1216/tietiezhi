//  AppDelegate.swift
//  Wires the app together: the settings store, the chat store, the controller the
//  UI talks to, a menu-bar status item, the primary Orbit window, plus the
//  dictation engine + global hotkey.

import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: SettingsStore!
    private var controller: AppController!
    private var chatStore: ChatStore!
    private var historyStore: DictationHistoryStore!
    private var usageStore: UsageStore!
    private var generationStore: GenerationStore!

    private var statusItem: NSStatusItem!
    private var chatWindow: NSWindow?
    private var onboardingWindow: NSWindow?

    private var engine: DictationEngine?
    private var hotkey: HotkeyMonitor?
    private var dictationQueue: DictationQueue!
    private var recordingState: RecordingState!
    private var resultStack: DictationStackController?

    private var hotkeyStarted = false
    private var didCompleteOnboarding = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        store = SettingsStore()
        controller = AppController(store: store)
        usageStore = UsageStore()
        chatStore = ChatStore(settings: store, usage: usageStore)
        generationStore = GenerationStore(settings: store, usage: usageStore)
        historyStore = DictationHistoryStore()
        dictationQueue = DictationQueue(store: store, history: historyStore, usage: usageStore)
        recordingState = RecordingState()

        installMainMenu()
        setupStatusItem()
        attachDictation()

        // Orbit is a regular Dock app (like Claude / Codex). Dictation keeps
        // running in the background regardless of windows.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        controller.refreshStatus()
        if controller.requiredPermissionsGranted {
            // Mic + accessibility in place → start the hotkey and go straight to
            // chat. If the tap can't install we surface Input Monitoring then.
            startHotkeyMonitor()
            showChat()
        } else {
            // Something's missing → don't fail silently in other apps. Gate on a
            // permission screen that polls live and hands off once all granted.
            controller.onPermissionsSatisfied = { [weak self] in self?.completeOnboarding() }
            controller.startPermissionPolling()
            showOnboarding()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        store.flush()
        hotkey?.stop()
    }

    /// Clicking the Dock icon with no windows re-opens the chat.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showChat()
        return true
    }

    // MARK: - Dictation wiring

    private func attachDictation() {
        let engine = DictationEngine(store: store, queue: dictationQueue, recording: recordingState)
        self.engine = engine
        resultStack = DictationStackController(queue: dictationQueue, recording: recordingState)

        let monitor = HotkeyMonitor(store: store)
        self.hotkey = monitor

        controller.onToggleDictation = { [weak engine] in engine?.toggleFromMenu() }
        controller.onBeginHotkeyCapture = { [weak monitor] in monitor?.beginCapture() }
        controller.onCancelHotkeyCapture = { [weak monitor] in monitor?.cancelCapture() }

        monitor.onCaptured = { [weak controller] code in
            controller?.finishHotkeyCapture(keycode: code)
        }
        // The gesture (hold vs double-tap) is resolved in the engine from raw
        // down/up transitions.
        monitor.onHotkeyDown = { [weak engine] in engine?.hotkeyDown() }
        monitor.onHotkeyUp = { [weak engine] in engine?.hotkeyUp() }
        monitor.onEscape = { [weak engine] in engine?.handleEscape() }
        // The tap needs Input Monitoring, so it's started later — only once that
        // grant is in place (see startHotkeyMonitor / the onboarding gate).
    }

    // MARK: - Permission gate (onboarding)

    /// Install the global hotkey tap exactly once, and surface a relaunch prompt
    /// if Input Monitoring was just granted but the tap can't take hold until the
    /// app restarts (a common macOS quirk for event taps).
    private func startHotkeyMonitor() {
        guard !hotkeyStarted else { return }
        hotkeyStarted = true
        hotkey?.onInstallResult = { [weak self] installed in
            if !installed { self?.promptRelaunchForHotkey() }
        }
        hotkey?.start()
    }

    private func showOnboarding() {
        if onboardingWindow == nil {
            let root = OnboardingView(
                controller: controller,
                onContinue: { [weak self] in self?.completeOnboarding() },
                onRelaunch: { [weak self] in self?.relaunch() }
            )
            let hosting = NSHostingController(rootView: root)
            let window = NSWindow(contentViewController: hosting)
            window.title = "欢迎使用 Orbit"
            window.styleMask = [.titled, .closable, .fullSizeContentView]
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.titlebarSeparatorStyle = .none
            window.isReleasedWhenClosed = false
            window.isRestorable = false
            window.contentMinSize = OnboardingView.contentSize
            window.contentMaxSize = OnboardingView.contentSize
            window.setContentSize(OnboardingView.contentSize)
            window.center()
            onboardingWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        onboardingWindow?.makeKeyAndOrderFront(nil)
    }

    /// Permissions are all in place (via the gate, or the user clicked 进入):
    /// start the hotkey, drop the onboarding window, reveal chat. Runs once.
    private func completeOnboarding() {
        guard !didCompleteOnboarding else { return }
        didCompleteOnboarding = true
        controller.stopPermissionPolling()
        startHotkeyMonitor()
        onboardingWindow?.close()
        onboardingWindow = nil
        showChat()
    }

    private func promptRelaunchForHotkey() {
        let alert = NSAlert()
        alert.messageText = "全局热键未能启用"
        alert.informativeText = "唤起听写的全局热键需要「输入监控」权限。请在「系统设置 → 隐私与安全性 → 输入监控」中开启 Orbit，然后重启 Orbit 使其生效。\n\n（其余功能不受影响：你仍可从菜单栏开始听写。）"
        alert.addButton(withTitle: "打开输入监控设置")
        alert.addButton(withTitle: "重启 Orbit")
        alert.addButton(withTitle: "稍后")
        switch alert.runModal() {
        case .alertFirstButtonReturn: Permissions.openInputMonitoringSettings()
        case .alertSecondButtonReturn: relaunch()
        default: break
        }
    }

    private func relaunch() {
        let url = Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    // MARK: - Status bar

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "waveform.circle",
                                   accessibilityDescription: "Orbit")
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "打开 Orbit", action: #selector(openChat(_:)), keyEquivalent: "")
        menu.addItem(withTitle: "设置…", action: #selector(showSettings(_:)), keyEquivalent: ",")
        menu.addItem(withTitle: "检查更新…", action: #selector(checkForUpdates(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "开始 / 停止听写",
                     action: #selector(toggleDictation(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Orbit", action: #selector(quit(_:)), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    @objc private func openChat(_ sender: Any?) {
        controller.openChatWorkspace()
        showChat()
    }
    @objc private func toggleDictation(_ sender: Any?) { controller.toggleDictation() }
    @objc private func quit(_ sender: Any?) { NSApp.terminate(nil) }
    @objc private func checkForUpdates(_ sender: Any?) {
        showChat()
        controller.openSettingsWorkspace(.about)
        controller.checkForUpdates()
    }

    // MARK: - Windows

    /// A window sharing Orbit's transparent, content-spanning titlebar chrome.
    private func chromedWindow<Content: View>(title: String, size: NSSize,
                                              autosaveName: String? = nil, content: Content) -> NSWindow {
        let hosting = NSHostingController(rootView: content)
        let window = NSWindow(contentViewController: hosting)
        window.title = title
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.setContentSize(size)
        // Remember the window's position + size across launches. On first launch
        // (no saved frame) center it on screen; afterwards restore where it was.
        if let autosaveName {
            window.setFrameAutosaveName(autosaveName)
            if !window.setFrameUsingName(autosaveName) { window.center() }
        } else {
            window.center()
        }
        window.isReleasedWhenClosed = false
        return window
    }

    func showChat() {
        if chatWindow == nil {
            let root = ChatRootView(openSettings: { [weak self] in self?.showSettings(nil) })
                .environmentObject(chatStore)
                .environmentObject(store)
                .environmentObject(controller)
                .environmentObject(historyStore)
                .environmentObject(usageStore)
                .environmentObject(generationStore)
            chatWindow = chromedWindow(title: "Orbit", size: NSSize(width: 960, height: 680),
                                       autosaveName: "OrbitMainWindow", content: root)
        }
        NSApp.activate(ignoringOtherApps: true)
        chatWindow?.makeKeyAndOrderFront(nil)
    }

    /// Settings switch into the main Orbit window.
    @objc func showSettings(_ sender: Any?) {
        showChat()
        controller.openSettingsWorkspace()
    }

    // MARK: - Main menu

    private func installMainMenu() {
        let mainMenu = NSMenu()

        // App menu (labelled with the bundle name automatically).
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "关于 Orbit",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        let updateItem = appMenu.addItem(withTitle: "检查更新…",
                                         action: #selector(checkForUpdates(_:)),
                                         keyEquivalent: "")
        updateItem.target = self
        appMenu.addItem(.separator())
        let settingsItem = appMenu.addItem(withTitle: "设置…",
                                           action: #selector(showSettings(_:)),
                                           keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Orbit",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Orbit",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // Edit menu — gives text fields the standard ⌘X/C/V/A + undo/redo.
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = mainMenu
    }
}
