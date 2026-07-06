//  PinWindow.swift
//  贴图 (Pin to screen)：a captured image floating above every window, Snipaste
//  style. Drag to move, scroll to zoom, ⌥scroll for opacity, double-click to
//  reset 100%, right-click for the menu (复制 / 另存 / 点击穿透 / 关闭), Esc or
//  ⌘W to close the focused pin. Multiple pins coexist under one controller.

import AppKit
import SwiftUI

@MainActor
final class PinController {
    private(set) var panels: [PinPanel] = []

    var count: Int { panels.count }

    /// Pin an image. `globalRect` (Cocoa global points) puts the pin exactly
    /// where the content was captured; nil centers it on the mouse screen.
    func pin(image: NSImage, at globalRect: CGRect? = nil) {
        let panel = PinPanel(image: image) { [weak self] closed in
            self?.panels.removeAll { $0 === closed }
        }
        if let rect = globalRect {
            panel.setFrameOrigin(rect.origin)
        } else {
            let screen = NSScreen.screens.first {
                NSMouseInRect(NSEvent.mouseLocation, $0.frame, false)
            } ?? NSScreen.main
            if let v = screen?.visibleFrame {
                panel.setFrameOrigin(NSPoint(x: v.midX - panel.frame.width / 2,
                                             y: v.midY - panel.frame.height / 2))
            }
        }
        panels.append(panel)
        panel.orderFrontRegardless()
    }

    /// Pin whatever image the clipboard holds. Returns false when it has none.
    @discardableResult
    func pinFromClipboard() -> Bool {
        let pb = NSPasteboard.general
        guard let image = NSImage(pasteboard: pb), image.size.width > 1 else { return false }
        pin(image: image)
        return true
    }

    func closeAll() {
        for panel in panels { panel.orderOut(nil) }
        panels.removeAll()
    }

    /// Escape hatch for pins switched to click-through (they no longer receive
    /// the context menu themselves).
    func disableAllClickThrough() {
        for panel in panels { panel.ignoresMouseEvents = false }
    }
}

// MARK: - The pin panel

@MainActor
final class PinPanel: NSPanel {
    private let image: NSImage
    private let baseSize: NSSize
    private var zoom: CGFloat = 1
    private let onClosed: (PinPanel) -> Void

    override var canBecomeKey: Bool { true }

    init(image: NSImage, onClosed: @escaping (PinPanel) -> Void) {
        self.image = image
        self.onClosed = onClosed
        // Clamp the initial size so a full-screen capture doesn't pin wall-to-wall.
        let limit = (NSScreen.main?.visibleFrame.size ?? NSSize(width: 1440, height: 900))
        let maxW = limit.width * 0.72, maxH = limit.height * 0.72
        var size = image.size
        let k = min(1, min(maxW / max(size.width, 1), maxH / max(size.height, 1)))
        size = NSSize(width: size.width * k, height: size.height * k)
        baseSize = size

        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false
        isMovableByWindowBackground = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let hosting = NSHostingView(rootView: PinContentView(image: image))
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = .clear
        contentView = hosting
    }

    // MARK: Interaction

    override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.option) {
            // ⌥滚轮 → 透明度
            let a = alphaValue - event.scrollingDeltaY * 0.012
            alphaValue = min(1, max(0.15, a))
            return
        }
        // 滚轮 → 缩放（以光标为锚点，内容不跑位）
        let factor = 1 + event.scrollingDeltaY * 0.01
        setZoom(zoom * factor, anchor: NSEvent.mouseLocation)
    }

    private func setZoom(_ newZoom: CGFloat, anchor: NSPoint) {
        let clamped = min(4, max(0.15, newZoom))
        guard abs(clamped - zoom) > 0.001 else { return }
        let old = frame
        let newSize = NSSize(width: baseSize.width * clamped, height: baseSize.height * clamped)
        // Keep the point under the cursor fixed while the frame rescales.
        let relX = old.width > 0 ? (anchor.x - old.minX) / old.width : 0.5
        let relY = old.height > 0 ? (anchor.y - old.minY) / old.height : 0.5
        let origin = NSPoint(x: anchor.x - newSize.width * relX,
                             y: anchor.y - newSize.height * relY)
        zoom = clamped
        setFrame(NSRect(origin: origin, size: newSize), display: true)
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            // 双击 → 回到 100%
            setZoom(1, anchor: NSPoint(x: frame.midX, y: frame.midY))
            return
        }
        makeKey()
        super.mouseDown(with: event)
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        menu.addItem(withTitle: "复制图片", action: #selector(copyImage), keyEquivalent: "").target = self
        menu.addItem(withTitle: "另存为…", action: #selector(saveImage), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "缩放到 100%", action: #selector(resetZoom), keyEquivalent: "").target = self
        let ct = menu.addItem(withTitle: "点击穿透（菜单栏可恢复）", action: #selector(enableClickThrough), keyEquivalent: "")
        ct.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "关闭贴图", action: #selector(closePin), keyEquivalent: "").target = self
        NSMenu.popUpContextMenu(menu, with: event, for: contentView!)
    }

    override func keyDown(with event: NSEvent) {
        let cmd = event.modifierFlags.contains(.command)
        if event.keyCode == 53 || (cmd && event.keyCode == 13) {   // Esc / ⌘W
            closePin()
            return
        }
        super.keyDown(with: event)
    }

    // MARK: Menu actions

    @objc private func copyImage() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.writeObjects([image])
    }

    @objc private func saveImage() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = "Pin \(Self.timestamp()).png"
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { [weak self] response in
            guard let self, response == .OK, let url = panel.url,
                  let cg = self.image.cgImage(forProposedRect: nil, context: nil, hints: nil)
            else { return }
            try? cg.writePNG(to: url)
        }
    }

    @objc private func resetZoom() {
        setZoom(1, anchor: NSPoint(x: frame.midX, y: frame.midY))
    }

    @objc private func enableClickThrough() {
        ignoresMouseEvents = true
        alphaValue = min(alphaValue, 0.85)   // subtle cue that it's inert now
    }

    @objc private func closePin() {
        orderOut(nil)
        onClosed(self)
    }

    static func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        return f.string(from: Date())
    }
}

private struct PinContentView: View {
    let image: NSImage
    @State private var hovering = false

    var body: some View {
        Image(nsImage: image)
            .resizable()
            .interpolation(.high)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(hovering
                                  ? Color(nsColor: .controlAccentColor).opacity(0.9)
                                  : Color.white.opacity(0.25),
                                  lineWidth: hovering ? 1.5 : 1)
            )
            .onHover { hovering = $0 }
    }
}
