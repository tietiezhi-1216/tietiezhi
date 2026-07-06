//  CapturePreview.swift
//  The post-capture quick-access thumbnail (CleanShot 风格): a small floating
//  card at the bottom-left after a capture finishes. Drag it into any app (it
//  carries the PNG file), click to reveal in Finder, or let it fade after a
//  few seconds. Hovering pauses the auto-dismiss.

import AppKit
import SwiftUI

@MainActor
final class CapturePreviewController {
    private var panel: NSPanel?
    private var dismissTask: Task<Void, Never>?

    func show(image: NSImage, fileURL: URL) {
        hide()

        let state = PreviewState(image: image, fileURL: fileURL)
        state.onClose = { [weak self] in self?.hide() }
        state.onHoverChange = { [weak self] hovering in
            if hovering { self?.dismissTask?.cancel() } else { self?.scheduleDismiss() }
        }

        let hosting = NSHostingView(rootView: PreviewCard(state: state))
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = .clear

        let size = NSSize(width: 224, height: 176)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                            styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = hosting
        self.panel = panel

        if let v = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: v.minX + 16, y: v.minY + 16))
        }
        panel.orderFrontRegardless()
        scheduleDismiss()
    }

    func hide() {
        dismissTask?.cancel()
        dismissTask = nil
        panel?.orderOut(nil)
        panel = nil
    }

    private func scheduleDismiss() {
        dismissTask?.cancel()
        dismissTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard !Task.isCancelled else { return }
            self?.hide()
        }
    }
}

@MainActor
private final class PreviewState: ObservableObject {
    let image: NSImage
    let fileURL: URL
    var onClose: (() -> Void)?
    var onHoverChange: ((Bool) -> Void)?

    init(image: NSImage, fileURL: URL) {
        self.image = image
        self.fileURL = fileURL
    }
}

private struct PreviewCard: View {
    @ObservedObject var state: PreviewState
    @State private var hovering = false

    var body: some View {
        VStack(spacing: 6) {
            Image(nsImage: state.image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 196, maxHeight: 120)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.white.opacity(0.2)))
                .onDrag { NSItemProvider(contentsOf: state.fileURL) ?? NSItemProvider() }
                .onTapGesture {
                    NSWorkspace.shared.activateFileViewerSelecting([state.fileURL])
                    state.onClose?()
                }

            HStack(spacing: 6) {
                Text("已截图 · 拖拽可发送")
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                Spacer(minLength: 0)
                Button { state.onClose?() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white.opacity(0.65))
                        .frame(width: 17, height: 17)
                        .background(Circle().fill(Color.white.opacity(0.14)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color(red: 0.09, green: 0.09, blue: 0.1).opacity(0.96))
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(.white.opacity(0.1)))
        )
        .shadow(color: .black.opacity(0.42), radius: 16, y: 7)
        .padding(6)
        .onHover { h in
            hovering = h
            state.onHoverChange?(h)
        }
    }
}
