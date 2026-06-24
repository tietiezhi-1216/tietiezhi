//  AppDelegate.swift
//  Wires the app together: the settings store, the chat store, the controller the
//  UI talks to, a menu-bar status item, the primary Chat window and the secondary
//  Settings window, plus the dictation engine + global hotkey.

import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: SettingsStore!
    private var controller: AppController!
    private var chatStore: ChatStore!

    private var statusItem: NSStatusItem!
    private var chatWindow: NSWindow?

    private var engine: DictationEngine?
    private var hotkey: HotkeyMonitor?

    func applicationDidFinishLaunching(_ notification: Notification) {
        store = SettingsStore()
        controller = AppController(store: store)
        chatStore = ChatStore(settings: store)

        installMainMenu()
        setupStatusItem()
        attachDictation()

        // Chat is Orbit's primary surface (like Claude / Codex) → a regular Dock
        // app. Dictation keeps running in the background regardless of windows.
        showChat()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
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
        let engine = DictationEngine(store: store)
        self.engine = engine

        let monitor = HotkeyMonitor(store: store)
        self.hotkey = monitor

        controller.onToggleDictation = { [weak engine] in engine?.toggle() }
        controller.onBeginHotkeyCapture = { [weak monitor] in monitor?.beginCapture() }
        controller.onCancelHotkeyCapture = { [weak monitor] in monitor?.cancelCapture() }

        monitor.onCaptured = { [weak controller] code in
            controller?.finishHotkeyCapture(keycode: code)
        }
        monitor.onHotkey = { [weak engine] in engine?.toggle() }

        monitor.start()
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
        menu.addItem(.separator())
        menu.addItem(withTitle: "开始 / 停止听写",
                     action: #selector(toggleDictation(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Orbit", action: #selector(quit(_:)), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    @objc private func openChat(_ sender: Any?) { showChat() }
    @objc private func toggleDictation(_ sender: Any?) { controller.toggleDictation() }
    @objc private func quit(_ sender: Any?) { NSApp.terminate(nil) }

    // MARK: - Windows

    /// A window sharing Orbit's transparent, content-spanning titlebar chrome.
    private func chromedWindow<Content: View>(title: String, size: NSSize, content: Content) -> NSWindow {
        let hosting = NSHostingController(rootView: content)
        let window = NSWindow(contentViewController: hosting)
        window.title = title
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.setContentSize(size)
        window.center()
        window.isReleasedWhenClosed = false
        return window
    }

    func showChat() {
        if chatWindow == nil {
            let root = ChatRootView(openSettings: { [weak self] in self?.showSettings(nil) })
                .environmentObject(chatStore)
                .environmentObject(store)
                .environmentObject(controller)
            chatWindow = chromedWindow(title: "Orbit", size: NSSize(width: 960, height: 680), content: root)
        }
        NSApp.activate(ignoringOtherApps: true)
        chatWindow?.makeKeyAndOrderFront(nil)
    }

    /// Settings open as a sheet inside the chat window (not a separate window).
    @objc func showSettings(_ sender: Any?) {
        controller.refreshStatus()
        showChat()
        controller.settingsPresented = true
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
