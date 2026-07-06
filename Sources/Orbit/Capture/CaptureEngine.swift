//  CaptureEngine.swift
//  Orchestrates the screenshot satellite: permission gate → freeze the mouse
//  screen → selection/annotation overlay → finish actions (copy / save / pin),
//  each of which also lands the capture in history. UI-independent — invoked
//  from the global hotkey, the menu bar, and settings.

import AppKit
import SwiftUI

@MainActor
final class CaptureEngine {
    private let store: SettingsStore
    private let history: ScreenshotHistoryStore
    private let usage: UsageStore?
    let pins = PinController()
    private let preview = CapturePreviewController()

    private var overlay: CaptureOverlayController?
    private var starting = false

    init(store: SettingsStore, history: ScreenshotHistoryStore, usage: UsageStore?) {
        self.store = store
        self.history = history
        self.usage = usage
        AIAnnotationSession.cleanTempImages()
    }

    var isCapturing: Bool { overlay != nil }

    // MARK: - Entry points

    /// 区域截图: freeze the screen under the mouse and open the overlay.
    /// Permission strategy: TRY the capture first and only guide the user when
    /// it actually fails — `CGPreflightScreenCaptureAccess` is unreliable for
    /// our self-signed dev identity (same macOS quirk as Input Monitoring, see
    /// AppController), so gating on it up front can lock out a granted app.
    func startRegionCapture() {
        guard overlay == nil, !starting else { return }

        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
        guard let screen else { return }

        starting = true
        Task { @MainActor in
            defer { starting = false }
            do {
                let frozen = try await ScreenCapturer.freeze(screen: screen)
                presentOverlay(frozen: frozen, screen: screen)
            } catch {
                NSLog("[capture] freeze failed: \(error.localizedDescription) (preflight=\(Permissions.screenRecording == .granted))")
                // SCShareableContent throws when the TCC grant is missing (or
                // hasn't taken effect in this launch) — that's the permission
                // path; anything else is a real capture failure.
                if Permissions.screenRecording != .granted {
                    showPermissionGuidance()
                } else {
                    notifyFailure("截图失败", error.localizedDescription)
                }
            }
        }
    }

    /// 贴图: pin the clipboard image.
    func pinClipboard() {
        if !pins.pinFromClipboard() {
            notifyFailure("无法贴图", "剪贴板里没有图片。先截图或复制一张图片，再按贴图快捷键。")
        }
    }

    func closeAllPins() { pins.closeAll() }
    func restorePinInteraction() { pins.disableAllClickThrough() }

    /// Pin an image from elsewhere (e.g. the history page).
    func pin(image: NSImage) { pins.pin(image: image) }

    // MARK: - Permission

    /// The capture actually failed on a missing/ineffective grant: trigger the
    /// system prompt (also registers us in the list) and walk the user through
    /// the two gotchas — the duplicate "Orbit" entry (release vs dev build)
    /// and the restart-to-take-effect rule.
    private func showPermissionGuidance() {
        Permissions.requestScreenRecording()

        let alert = NSAlert()
        alert.messageText = "截图需要「屏幕录制」权限"
        alert.informativeText = """
        请在「系统设置 → 隐私与安全性 → 屏幕录制与系统录音」中开启 Orbit。

        注意两点：
        1. 如果列表里有多个「Orbit」（正式版与开发版同名），请全部开启；
        2. 开启后 macOS 会要求退出并重新打开 Orbit —— 必须重启一次授权才生效。

        另外 macOS 15 起系统会每月弹窗确认一次该权限，属正常机制。
        """
        alert.addButton(withTitle: "打开系统设置")
        alert.addButton(withTitle: "重启 Orbit")
        alert.addButton(withTitle: "稍后")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            Permissions.openScreenRecordingSettings()
        case .alertSecondButtonReturn:
            relaunchApp()
        default:
            break
        }
    }

    private func relaunchApp() {
        let url = Bundle.main.bundleURL
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    // MARK: - Overlay lifecycle

    private func presentOverlay(frozen: CGImage, screen: NSScreen) {
        let session = CaptureSessionModel(
            frozen: frozen,
            scale: screen.backingScaleFactor,
            canvasSize: screen.frame.size,
            windows: ScreenCapturer.snapWindows(on: screen),
            settings: store,
            usage: usage
        )
        let controller = CaptureOverlayController(session: session, screen: screen)
        session.onCancel = { [weak self] in self?.dismissOverlay() }
        session.onFinish = { [weak self, weak controller, weak session] action in
            guard let self, let controller, let session else { return }
            self.finish(action: action, session: session, controller: controller)
        }
        overlay = controller
        controller.show()
    }

    private func dismissOverlay() {
        overlay?.session.ai.cancel()
        overlay?.close()
        overlay = nil
    }

    // MARK: - Finish

    private func finish(action: CaptureFinishAction, session: CaptureSessionModel,
                        controller: CaptureOverlayController) {
        guard let crop = session.crop, let selection = session.selection else { return }
        session.ai.cancel()

        let result = CaptureResult(
            action: action,
            crop: crop,
            annotations: session.editor.annotations,
            pixelated: session.pixelated,
            pointSize: selection.size,
            scale: session.scale,
            globalRect: controller.globalRect(for: selection),
            source: session.source,
            aiPrompt: session.ai.lastInstruction
        )

        guard let final = AnnotationExporter.render(
            crop: crop, annotations: result.annotations,
            pointSize: result.pointSize, pixelated: result.pixelated, scale: result.scale
        ) else {
            session.showToast("图像合成失败")
            return
        }

        // The save dialog needs the overlay gone first (it floats above all).
        dismissOverlay()

        switch action {
        case .copy:
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.writeObjects([final])
            let entry = persist(result: result, final: final)
            if store.settings.capture.showQuickPreview, let entry {
                preview.show(image: final, fileURL: entry.imageURL)
            }

        case .pin:
            pins.pin(image: final, at: result.globalRect)
            if store.settings.capture.copyAfterCapture {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.writeObjects([final])
            }
            _ = persist(result: result, final: final)

        case .save:
            let entry = persist(result: result, final: final)
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.png]
            panel.nameFieldStringValue = "Orbit 截图 \(PinPanel.timestamp()).png"
            NSApp.activate(ignoringOtherApps: true)
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                if let entry {
                    try? FileManager.default.copyItem(at: entry.imageURL, to: url)
                } else if let cg = final.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                    try? cg.writePNG(to: url)
                }
            }
        }
    }

    /// Write final (+original) PNGs into ~/.orbit/screenshots and record the entry.
    @discardableResult
    private func persist(result: CaptureResult, final: NSImage) -> ScreenshotEntry? {
        let dir = ScreenshotHistoryStore.imagesDirectory()
        let id = UUID().uuidString
        let finalURL = dir.appendingPathComponent("\(id).png")
        let originalURL = dir.appendingPathComponent("\(id)-original.png")

        guard let finalCG = final.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return nil
        }
        do {
            try finalCG.writePNG(to: finalURL)
        } catch {
            NSLog("[capture] 保存截图失败: \(error.localizedDescription)")
            return nil
        }
        // The clean crop only matters once annotations exist.
        var originalPath: String?
        if !result.annotations.isEmpty {
            try? result.crop.writePNG(to: originalURL)
            originalPath = originalURL.path
        }

        let entry = ScreenshotEntry(
            id: id,
            date: Date(),
            imagePath: finalURL.path,
            originalPath: originalPath,
            annotations: result.annotations.isEmpty ? nil : result.annotations,
            width: Int(result.pointSize.width * result.scale),
            height: Int(result.pointSize.height * result.scale),
            source: result.source,
            aiPrompt: result.aiPrompt
        )
        history.add(entry)
        return entry
    }

    // MARK: - Failure surface

    private func notifyFailure(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
