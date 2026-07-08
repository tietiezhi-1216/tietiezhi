//  CaptureEngine.swift
//  Orchestrates the screenshot satellite: permission gate → freeze the mouse
//  screen → selection/annotation overlay → finish actions (copy / save / pin),
//  each of which also lands the capture in history. UI-independent — invoked
//  from the global hotkey, the menu bar, and settings.

import AppKit
import SwiftUI
import ScreenCaptureKit

@MainActor
final class CaptureEngine {
    private let store: SettingsStore
    private let history: ScreenshotHistoryStore
    private let usage: UsageStore?
    let pins = PinController()
    private let preview = CapturePreviewController()

    private var overlay: CaptureOverlayController?
    private var starting = false
    private var axPrompted = false
    /// The app that was frontmost when capture began — restored on finish so we
    /// don't leave Orbit (which had to activate to show the overlay) in front.
    private var previousApp: NSRunningApplication?

    init(store: SettingsStore, history: ScreenshotHistoryStore, usage: UsageStore?) {
        self.store = store
        self.history = history
        self.usage = usage
        AIAnnotationSession.cleanTempImages()
    }

    var isCapturing: Bool { overlay != nil }

    /// One-shot startup probe: which binary is running, and can it actually reach
    /// ScreenCaptureKit? Written to ~/.orbit/capture-debug.log so "granted but
    /// still says not granted" can be diagnosed without guessing — the log tells
    /// us the exact bundle id / path (dev vs release) and whether SCShareableContent
    /// really succeeds for THIS process.
    func logStartupDiagnostic() {
        let id = Bundle.main.bundleIdentifier ?? "?"
        let path = Bundle.main.bundlePath
        let preflight = CGPreflightScreenCaptureAccess()
        CaptureLog.log("——— 启动自检 ———")
        CaptureLog.log("运行的 App: \(id)  路径: \(path)")
        CaptureLog.log("CGPreflightScreenCaptureAccess = \(preflight)")
        Task { @MainActor in
            do {
                let content = try await withCaptureTimeout(seconds: 6) {
                    try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                }
                CaptureLog.log("✅ SCShareableContent 成功：\(content.displays.count) 个显示器、\(content.windows.count) 个窗口——屏幕录制对本 App 有效")
            } catch {
                CaptureLog.log("❌ SCShareableContent 失败：\(error.localizedDescription)——屏幕录制对本 App【无效】，主动发起系统授权请求。")
                // Proactively trigger the system screen-recording prompt on launch
                // (rather than only on the first capture attempt), so a fresh
                // install registers in the list and the user can grant it right away.
                Permissions.requestScreenRecording()
            }
        }
    }

    // MARK: - Entry points

    /// 区域截图: freeze the screen under the mouse and open the overlay.
    /// Permission strategy: TRY the capture first and only guide the user when
    /// it actually fails — `CGPreflightScreenCaptureAccess` is unreliable for
    /// our self-signed dev identity (same macOS quirk as Input Monitoring, see
    /// AppController), so gating on it up front can lock out a granted app.
    func startRegionCapture() {
        CaptureLog.log("startRegionCapture 被调用 (overlay=\(overlay != nil) starting=\(starting) 屏幕录制=\(Permissions.screenRecording == .granted ? "已授权" : "未授权"))")
        guard overlay == nil, !starting else {
            CaptureLog.log("提前返回：已有 overlay 或正在启动")
            return
        }

        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
        guard let screen else { CaptureLog.log("找不到目标屏幕"); return }

        // Remember who's in front (usually another app) BEFORE we activate to show
        // the overlay, so finishing can hand focus back instead of leaving Orbit up.
        previousApp = NSWorkspace.shared.frontmostApplication

        starting = true
        Task { @MainActor in
            defer { starting = false }
            do {
                CaptureLog.log("开始冻结屏幕…")
                // Hard timeout: SCScreenshotManager can wedge when the screen-
                // recording grant is half-applied. Without this, `starting` (reset
                // only by the defer below) would stay true forever and every later
                // press would silently early-return — the hotkey looks dead.
                let frozen = try await withCaptureTimeout(seconds: 6) {
                    try await ScreenCapturer.freeze(screen: screen)
                }
                CaptureLog.log("冻结成功 (\(frozen.width)x\(frozen.height))，展示遮罩")
                presentOverlay(frozen: frozen, screen: screen)
            } catch {
                CaptureLog.log("❌ 冻结失败: \(error.localizedDescription) (屏幕录制=\(Permissions.screenRecording == .granted ? "已授权" : "未授权"))")
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
            screenFrame: screen.frame,
            windows: ScreenCapturer.snapWindows(on: screen),
            settings: store,
            usage: usage
        )
        // AX self-check: element snapping / AI node anchors need Accessibility. The
        // dev build (com.orbit.app.dev) is a SEPARATE TCC identity from release, so
        // it may be ungranted even if release is — log it and prompt once.
        if AXScanner.isAvailable {
            CaptureLog.log("✅ 辅助功能已授权（AX 可用）——元素吸附/AI节点应生效")
            // Wake every candidate app's AX tree NOW — Electron/Chromium build
            // theirs asynchronously; by the time the user hovers, it's ready.
            var pids: [pid_t] = []
            for w in session.windows where !pids.contains(w.pid) { pids.append(w.pid) }
            AXScanner.prewarm(pids: pids)
            // …then scan whole trees into the snap cache (hover = local geometry).
            session.prescanElements()
        } else {
            CaptureLog.log("⚠️ 辅助功能未授权 AXIsProcessTrusted=false——元素吸附/AI节点不可用。bundle=\(Bundle.main.bundleIdentifier ?? "?")")
            if !axPrompted { axPrompted = true; AXScanner.requestPermission() }
        }

        let controller = CaptureOverlayController(session: session, screen: screen)
        session.onCancel = { [weak self] in
            // Hand focus back, then close the overlay a beat later — avoids Orbit
            // flashing to the front on cancel.
            self?.handOffAndDismiss()
        }
        session.onFinish = { [weak self, weak controller, weak session] action in
            guard let self, let controller, let session else { return }
            self.finish(action: action, session: session, controller: controller)
        }
        session.onCopyStay = { [weak session] in
            guard let session else { return }
            CaptureEngine.copyToClipboard(session: session)
        }
        overlay = controller
        controller.show()
    }

    private func dismissOverlay() {
        overlay?.session.ai.cancel()
        overlay?.close()
        overlay = nil
    }

    /// Hand focus back to whatever app was frontmost before capture — the overlay
    /// had to activate Orbit, but the user expects to land back where they were.
    private func restorePreviousApp() {
        guard let app = previousApp,
              app.bundleIdentifier != Bundle.main.bundleIdentifier,
              !app.isTerminated else { return }
        app.activate()
    }

    private var handOffObserver: NSObjectProtocol?

    /// Activate the origin app, and only remove the (opaque, top-most) overlay once
    /// macOS confirms a non-Orbit app is frontmost. A fixed delay proved unreliable
    /// (cross-process activation lands whenever it likes, and orderOut of the key
    /// panel while Orbit is still active re-keys + raises the MAIN window — the
    /// flash). Event-driven: NSWorkspace.didActivateApplication is the ground truth,
    /// with a 500ms fallback so the overlay can never get stuck. `then` runs after.
    private func handOffAndDismiss(then: (() -> Void)? = nil) {
        let ourBundle = Bundle.main.bundleIdentifier

        // No app to restore (capture was triggered from Orbit itself, or the origin
        // app died): nothing can flash "over" us meaningfully — dismiss directly.
        guard let target = previousApp, target.bundleIdentifier != ourBundle,
              !target.isTerminated else {
            CaptureLog.log("交还焦点：无外部来源 App（来源即 Orbit），直接撤除遮罩")
            dismissOverlay()
            then?()
            return
        }

        var finished = false
        let finish: (String) -> Void = { [weak self] reason in
            guard let self, !finished else { return }
            finished = true
            if let obs = self.handOffObserver {
                NSWorkspace.shared.notificationCenter.removeObserver(obs)
                self.handOffObserver = nil
            }
            CaptureLog.log("撤除遮罩（\(reason)，前台=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")）")
            self.dismissOverlay()
            // The activation at overlay-show raised Orbit's main window; the user
            // captured from another app and doesn't want it surfacing. orderBack
            // wasn't enough — it still shows through the gaps around the restored
            // app. Hide it outright (pill/pins panels stay). It's reopenable from
            // the Dock / menu bar (applicationShouldHandleReopen → showChat).
            for w in NSApp.windows where w.isVisible && !(w is NSPanel) {
                w.orderOut(nil)
            }
            then?()
        }

        CaptureLog.log("交还焦点 → \(target.localizedName ?? target.bundleIdentifier ?? "?")")
        handOffObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            guard app?.bundleIdentifier != ourBundle else { return }
            Task { @MainActor in finish("前台已切换") }
        }
        target.activate()
        NSApp.deactivate()
        // Fallback: if the notification never lands (target refused activation),
        // reveal anyway after 500ms rather than wedging the screen.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            finish("超时兜底")
        }
    }

    // MARK: - Finish

    /// Render the current annotated crop and copy it to the clipboard WITHOUT
    /// closing the editor — the 复制 button, so the user can paste elsewhere and
    /// keep annotating / pinning / saving the same shot.
    static func copyToClipboard(session: CaptureSessionModel) {
        guard let crop = session.crop, let selection = session.selection else { return }
        guard let final = AnnotationExporter.render(
            crop: crop, annotations: session.editor.annotations,
            pointSize: selection.size, pixelated: session.pixelated, scale: session.scale,
            beautify: session.beautifyParams
        ) else {
            session.showToast("图像合成失败")
            return
        }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.writeObjects([final])
        session.showToast("已复制到剪贴板")
    }

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
            pointSize: result.pointSize, pixelated: result.pixelated, scale: result.scale,
            beautify: session.beautifyParams
        ) else {
            session.showToast("图像合成失败")
            return
        }

        switch action {
        case .copy:
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.writeObjects([final])
            let entry = persist(result: result, final: final)
            handOffAndDismiss { [weak self] in
                guard let self, self.store.settings.capture.showQuickPreview, let entry else { return }
                self.preview.show(image: final, fileURL: entry.imageURL)
            }

        case .pin:
            pins.pin(image: final, at: result.globalRect)
            if store.settings.capture.copyAfterCapture {
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.writeObjects([final])
            }
            _ = persist(result: result, final: final)
            handOffAndDismiss()

        case .save:
            let entry = persist(result: result, final: final)
            dismissOverlay()   // the save dialog needs the overlay gone first
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.png]
            panel.nameFieldStringValue = "Orbit 截图 \(PinPanel.timestamp()).png"
            NSApp.activate(ignoringOtherApps: true)
            panel.begin { [weak self] response in
                if response == .OK, let url = panel.url {
                    if let entry {
                        try? FileManager.default.copyItem(at: entry.imageURL, to: url)
                    } else if let cg = final.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                        try? cg.writePNG(to: url)
                    }
                }
                // The save panel is done — hand focus back to the origin app.
                Task { @MainActor in self?.restorePreviousApp() }
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
