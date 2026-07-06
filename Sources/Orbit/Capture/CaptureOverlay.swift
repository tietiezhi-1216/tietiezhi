//  CaptureOverlay.swift
//  The full-screen capture surface: a borderless key panel showing the FROZEN
//  desktop (captured before the panel appears, so the UI never shoots itself),
//  with rubber-band selection, window hover-snap, a pixel magnifier + colour
//  pick while selecting — then, once a region is fixed, the in-place annotation
//  editor (canvas + toolbar + the AI composer bar) without leaving the screen.

import AppKit
import SwiftUI

// MARK: - Result handed back to the engine

enum CaptureFinishAction {
    case copy      // 完成：复制到剪贴板（+历史）
    case save      // 另存为…
    case pin       // 贴到屏幕
}

struct CaptureResult {
    let action: CaptureFinishAction
    let crop: CGImage             // clean crop, native pixels
    let annotations: [Annotation]
    let pixelated: CGImage?
    let pointSize: CGSize
    let scale: CGFloat
    /// Selection in GLOBAL Cocoa coordinates (for pinning in place).
    let globalRect: CGRect
    let source: String            // "region" / "window"
    let aiPrompt: String?
}

// MARK: - Session model

@MainActor
final class CaptureSessionModel: ObservableObject {
    enum Phase { case selecting, editing }

    @Published var phase: Phase = .selecting
    @Published var hoverPoint: CGPoint?
    @Published var hoverWindow: CGRect?
    @Published var dragRect: CGRect?
    @Published var selection: CGRect?
    @Published var toast: String?

    let frozen: CGImage
    let scale: CGFloat
    let canvasSize: CGSize        // screen size in points
    let windows: [SnapWindow]
    let editor: AnnotationEditorState
    let ai: AIAnnotationSession

    /// Set when editing starts.
    @Published var crop: CGImage?
    @Published var pixelated: CGImage?
    var source = "region"

    var onCancel: (() -> Void)?
    var onFinish: ((CaptureFinishAction) -> Void)?

    private var toastTask: Task<Void, Never>?

    init(frozen: CGImage, scale: CGFloat, canvasSize: CGSize,
         windows: [SnapWindow], settings: SettingsStore, usage: UsageStore?) {
        self.frozen = frozen
        self.scale = scale
        self.canvasSize = canvasSize
        self.windows = windows
        self.editor = AnnotationEditorState()
        self.ai = AIAnnotationSession(settings: settings, usage: usage)
    }

    func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }
            toast = nil
        }
    }

    /// Fix the selection and enter the editor.
    func beginEditing(_ rect: CGRect, source: String) {
        let clamped = rect.intersection(CGRect(origin: .zero, size: canvasSize)).integral
        guard clamped.width >= 8, clamped.height >= 8 else { return }
        guard let cropped = frozen.cropping(toPointRect: clamped, scale: scale) else { return }
        self.source = source
        selection = clamped
        crop = cropped
        pixelated = cropped.pixelated(scale: scale)
        dragRect = nil
        hoverWindow = nil
        phase = .editing
    }

    /// Pixel colour under the cursor (selecting phase).
    var hoverColor: NSColor? {
        hoverPoint.flatMap { frozen.pixelColor(atPoint: $0, scale: scale) }
    }

    func copyHoverColor() {
        guard let c = hoverColor else { return }
        let hex = String(format: "#%02X%02X%02X",
                         Int(round(c.redComponent * 255)),
                         Int(round(c.greenComponent * 255)),
                         Int(round(c.blueComponent * 255)))
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(hex, forType: .string)
        showToast("已复制颜色 \(hex)")
    }
}

// MARK: - Panel + controller

/// Borderless panels can't normally become key; the capture surface must (text
/// input for the AI bar and text annotations, Esc, ⌘Z…).
final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class CaptureOverlayController {
    let session: CaptureSessionModel
    private var panel: NSPanel?
    private var keyMonitor: Any?
    let screen: NSScreen

    init(session: CaptureSessionModel, screen: NSScreen) {
        self.session = session
        self.screen = screen
    }

    func show() {
        let hosting = NSHostingView(rootView: CaptureOverlayRoot(session: session))
        hosting.wantsLayer = true
        let panel = KeyablePanel(
            contentRect: screen.frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.backgroundColor = .black
        panel.isOpaque = true
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.acceptsMouseMovedEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = hosting
        panel.setFrame(screen.frame, display: true)
        self.panel = panel
        panel.makeKeyAndOrderFront(nil)
        NSCursor.crosshair.push()
        installKeyMonitor()
    }

    func close() {
        NSCursor.pop()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        panel?.orderOut(nil)
        panel = nil
    }

    /// Selection rect (view coords, top-left origin) → global Cocoa rect.
    func globalRect(for viewRect: CGRect) -> CGRect {
        CGRect(x: screen.frame.minX + viewRect.minX,
               y: screen.frame.maxY - viewRect.maxY,
               width: viewRect.width, height: viewRect.height)
    }

    // MARK: Keyboard

    /// One local monitor handles every editor shortcut. Returning nil swallows
    /// the event; text-field editing passes through untouched (except Esc,
    /// which ends the edit instead of killing the whole capture).
    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.panel else { return event }
            return self.handleKey(event)
        }
    }

    private func handleKey(_ event: NSEvent) -> NSEvent? {
        let s = session
        let editingText = panel?.firstResponder is NSTextView

        if event.keyCode == 53 {   // Esc
            if editingText {
                panel?.makeFirstResponder(panel?.contentView)
                s.editor.editingTextID = nil
                return nil
            }
            if s.editor.selectedID != nil {
                s.editor.selectedID = nil
                return nil
            }
            s.onCancel?()
            return nil
        }
        if editingText { return event }

        let cmd = event.modifierFlags.contains(.command)
        let shift = event.modifierFlags.contains(.shift)

        switch (event.keyCode, cmd, shift) {
        case (8, false, false) where s.phase == .selecting:    // C → 取色
            s.copyHoverColor()
            return nil
        case (36, false, _), (76, false, _):                   // Return / Enter → 完成
            if s.phase == .editing { s.onFinish?(.copy); return nil }
            return event
        case (6, true, false):                                 // ⌘Z
            s.editor.undo(); return nil
        case (6, true, true):                                  // ⇧⌘Z
            s.editor.redo(); return nil
        case (51, false, false), (117, false, false):          // Delete
            if s.phase == .editing { s.editor.removeSelected(); return nil }
            return event
        case (8, true, false):                                 // ⌘C
            if s.phase == .editing { s.onFinish?(.copy); return nil }
            return event
        case (1, true, false):                                 // ⌘S
            if s.phase == .editing { s.onFinish?(.save); return nil }
            return event
        default:
            return event
        }
    }
}

// MARK: - Root view

struct CaptureOverlayRoot: View {
    @ObservedObject var session: CaptureSessionModel

    var body: some View {
        ZStack(alignment: .topLeading) {
            Image(decorative: session.frozen, scale: session.scale)
                .resizable()
                .frame(width: session.canvasSize.width, height: session.canvasSize.height)

            switch session.phase {
            case .selecting: SelectingLayer(session: session)
            case .editing:   EditingLayer(session: session)
            }

            if let toast = session.toast {
                ToastView(text: toast, canvas: session.canvasSize)
            }
        }
        .frame(width: session.canvasSize.width, height: session.canvasSize.height)
        .ignoresSafeArea()
    }
}

/// Even-odd dim: everything except `cutout` under 45% black.
private struct DimLayer: View {
    let canvas: CGSize
    let cutout: CGRect?

    var body: some View {
        Canvas { ctx, _ in
            var path = Path(CGRect(origin: .zero, size: canvas))
            if let cutout { path.addRect(cutout) }
            ctx.fill(path, with: .color(.black.opacity(0.45)), style: FillStyle(eoFill: true))
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Selecting phase

private struct SelectingLayer: View {
    @ObservedObject var session: CaptureSessionModel

    var body: some View {
        let active = session.dragRect ?? session.hoverWindow

        ZStack(alignment: .topLeading) {
            DimLayer(canvas: session.canvasSize, cutout: active)

            if let rect = active {
                SelectionBorder(rect: rect, dragging: session.dragRect != nil)
                SizeLabel(rect: rect, canvas: session.canvasSize)
            }

            if session.dragRect == nil, let p = session.hoverPoint {
                MagnifierView(session: session, cursor: p)
            }

            if session.dragRect == nil && session.hoverWindow == nil {
                HintBadge(canvas: session.canvasSize)
            }

            // The interaction surface (kept last so it owns the gestures).
            Color.clear
                .contentShape(Rectangle())
                .gesture(selectGesture)
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let p):
                        session.hoverPoint = p
                        if session.dragRect == nil {
                            session.hoverWindow = session.windows.first { $0.frame.contains(p) }?
                                .frame
                                .intersection(CGRect(origin: .zero, size: session.canvasSize))
                        }
                    case .ended:
                        session.hoverPoint = nil
                    }
                }
        }
    }

    private var selectGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let a = value.startLocation, b = value.location
                session.hoverPoint = b
                if a.distance(to: b) > 4 {
                    session.dragRect = CGRect(x: min(a.x, b.x), y: min(a.y, b.y),
                                              width: abs(b.x - a.x), height: abs(b.y - a.y))
                }
            }
            .onEnded { value in
                if let rect = session.dragRect {
                    session.beginEditing(rect, source: "region")
                } else if let win = session.hoverWindow {
                    // A plain click snaps to the hovered window.
                    session.beginEditing(win, source: "window")
                }
                session.dragRect = nil
            }
    }
}

private struct SelectionBorder: View {
    let rect: CGRect
    var dragging = false

    var body: some View {
        Rectangle()
            .strokeBorder(Color(nsColor: .controlAccentColor), lineWidth: dragging ? 1.5 : 2)
            .background(Rectangle().strokeBorder(.white.opacity(0.55), lineWidth: 0.5).padding(-1))
            .frame(width: max(1, rect.width), height: max(1, rect.height))
            .offset(x: rect.minX, y: rect.minY)
            .allowsHitTesting(false)
    }
}

private struct SizeLabel: View {
    let rect: CGRect
    let canvas: CGSize

    var body: some View {
        let above = rect.minY > 26
        Text("\(Int(rect.width)) × \(Int(rect.height))")
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Color.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 5))
            .offset(x: min(rect.minX, canvas.width - 90),
                    y: above ? rect.minY - 24 : rect.minY + 6)
            .allowsHitTesting(false)
    }
}

private struct HintBadge: View {
    let canvas: CGSize

    var body: some View {
        Text("拖拽框选区域 · 点击选中窗口 · C 取色 · Esc 取消")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.white.opacity(0.92))
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(Color.black.opacity(0.6), in: Capsule())
            .frame(maxWidth: .infinity)
            .offset(y: 24)
            .allowsHitTesting(false)
            .frame(width: canvas.width, alignment: .center)
    }
}

/// Pixel magnifier + colour readout following the cursor while selecting.
private struct MagnifierView: View {
    @ObservedObject var session: CaptureSessionModel
    let cursor: CGPoint

    private let zoomPixels = 15          // 15×15 source pixels
    private let paneSize: CGFloat = 120

    var body: some View {
        let half = CGFloat(zoomPixels) / 2 / session.scale
        let region = CGRect(x: cursor.x - half, y: cursor.y - half,
                            width: half * 2, height: half * 2)
        let sample = session.frozen.cropping(toPointRect: region, scale: session.scale)
        let hex = session.hoverColor.map {
            String(format: "#%02X%02X%02X",
                   Int(round($0.redComponent * 255)),
                   Int(round($0.greenComponent * 255)),
                   Int(round($0.blueComponent * 255)))
        }

        VStack(alignment: .leading, spacing: 4) {
            if let sample {
                ZStack {
                    Image(decorative: sample, scale: 1)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: paneSize, height: paneSize)
                    // Crosshair over the centre pixel.
                    Rectangle().fill(Color(nsColor: .controlAccentColor).opacity(0.85))
                        .frame(width: paneSize / CGFloat(zoomPixels), height: 1)
                    Rectangle().fill(Color(nsColor: .controlAccentColor).opacity(0.85))
                        .frame(width: 1, height: paneSize / CGFloat(zoomPixels))
                }
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(.white.opacity(0.4)))
            }
            HStack(spacing: 6) {
                if let c = session.hoverColor {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color(nsColor: c))
                        .frame(width: 14, height: 14)
                        .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(.white.opacity(0.4)))
                }
                Text("\(hex ?? "—")  (\(Int(cursor.x)), \(Int(cursor.y)))  C 复制")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.92))
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Color.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 5))
        }
        .offset(x: magnifierOrigin.x, y: magnifierOrigin.y)
        .allowsHitTesting(false)
    }

    private var magnifierOrigin: CGPoint {
        var x = cursor.x + 18
        var y = cursor.y + 18
        if x + paneSize + 20 > session.canvasSize.width { x = cursor.x - paneSize - 18 }
        if y + paneSize + 48 > session.canvasSize.height { y = cursor.y - paneSize - 48 }
        return CGPoint(x: x, y: y)
    }
}

// MARK: - Editing phase

private struct EditingLayer: View {
    @ObservedObject var session: CaptureSessionModel
    @State private var clusterSize: CGSize = .zero

    var body: some View {
        ZStack(alignment: .topLeading) {
            DimLayer(canvas: session.canvasSize, cutout: session.selection)

            if let sel = session.selection {
                SelectionBorder(rect: sel)
                SizeLabel(rect: sel, canvas: session.canvasSize)

                AnnotationCanvasView(editor: session.editor,
                                     size: sel.size,
                                     pixelated: session.pixelated,
                                     displayScale: session.scale)
                    .offset(x: sel.minX, y: sel.minY)

                controlCluster(selection: sel)
            }
        }
    }

    @ViewBuilder
    private func controlCluster(selection: CGRect) -> some View {
        let width = min(max(selection.width, 560), session.canvasSize.width - 24)
        VStack(alignment: .leading, spacing: 8) {
            CaptureToolbar(session: session)
            AIComposerBar(session: session)
        }
        .frame(width: width, alignment: .leading)
        .background(
            GeometryReader { geo in
                Color.clear.preference(key: ClusterSizeKey.self, value: geo.size)
            }
        )
        .onPreferenceChange(ClusterSizeKey.self) { clusterSize = $0 }
        .offset(clusterOffset(selection: selection, width: width))
    }

    private func clusterOffset(selection: CGRect, width: CGFloat) -> CGSize {
        let h = clusterSize.height > 0 ? clusterSize.height : 96
        let x = min(max(8, selection.minX), session.canvasSize.width - width - 12)
        var y = selection.maxY + 10
        if y + h > session.canvasSize.height - 10 {
            y = selection.minY - h - 10                 // no room below → above
            if y < 10 { y = selection.maxY - h - 10 }   // nor above → inside
        }
        return CGSize(width: x, height: max(10, y))
    }
}

private struct ClusterSizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

// MARK: - Toolbar

private struct CaptureToolbar: View {
    @ObservedObject var session: CaptureSessionModel
    @ObservedObject private var editor: AnnotationEditorState
    @State private var showPalette = false

    init(session: CaptureSessionModel) {
        self.session = session
        self.editor = session.editor
    }

    private static let tools: [AnnotationKind] = [
        .arrow, .line, .rect, .ellipse, .freehand, .text, .highlight, .mosaic, .badge,
    ]

    var body: some View {
        HStack(spacing: 3) {
            toolButton(icon: "cursorarrow", help: "选择 / 移动", active: editor.tool == nil) {
                editor.tool = nil
            }
            ForEach(Self.tools) { kind in
                toolButton(icon: kind.symbol, help: kind.displayName, active: editor.tool == kind) {
                    editor.tool = kind
                }
            }

            divider

            // Colour + line-width popover.
            Button { showPalette.toggle() } label: {
                Circle()
                    .fill(editor.color.color)
                    .frame(width: 15, height: 15)
                    .overlay(Circle().strokeBorder(.white.opacity(0.7), lineWidth: 1))
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .help("颜色与线宽")
            .popover(isPresented: $showPalette, arrowEdge: .bottom) {
                StylePalette(editor: editor)
            }

            divider

            toolButton(icon: "arrow.uturn.backward", help: "撤销 ⌘Z",
                       disabled: !editor.canUndo) { editor.undo() }
            toolButton(icon: "arrow.uturn.forward", help: "重做 ⇧⌘Z",
                       disabled: !editor.canRedo) { editor.redo() }

            divider

            toolButton(icon: "text.viewfinder", help: "提取文字（OCR）") { runOCR() }
            toolButton(icon: "pin", help: "贴到屏幕") { session.onFinish?(.pin) }
            toolButton(icon: "square.and.arrow.down", help: "另存为… ⌘S") { session.onFinish?(.save) }

            Spacer(minLength: 4)

            toolButton(icon: "xmark", help: "取消 Esc") { session.onCancel?() }
            Button { session.onFinish?(.copy) } label: {
                Label("完成", systemImage: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 11)
                    .frame(height: 26)
                    .background(Color(nsColor: .controlAccentColor), in: Capsule())
            }
            .buttonStyle(.plain)
            .help("复制到剪贴板 ⏎")
        }
        .padding(.horizontal, 8)
        .frame(height: 40)
        .background(chrome)
    }

    private var divider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1, height: 18).padding(.horizontal, 3)
    }

    private func toolButton(icon: String, help: String, active: Bool = false,
                            disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(disabled ? .white.opacity(0.25)
                                 : active ? Color.black.opacity(0.85) : .white.opacity(0.9))
                .frame(width: 26, height: 26)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(active ? Color.white.opacity(0.92) : .clear)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .help(help)
    }

    private var chrome: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(Color.black.opacity(0.86))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(.white.opacity(0.12)))
            .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
    }

    private func runOCR() {
        guard let crop = session.crop, let sel = session.selection else { return }
        Task { @MainActor in
            do {
                let lines = try await OCRService.recognize(in: crop, pointSize: sel.size)
                guard !lines.isEmpty else {
                    session.showToast("未识别到文字")
                    return
                }
                let text = OCRService.joined(lines)
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.setString(text, forType: .string)
                session.showToast("已复制 \(lines.count) 行文字")
            } catch {
                session.showToast(error.localizedDescription)
            }
        }
    }
}

private struct StylePalette: View {
    @ObservedObject var editor: AnnotationEditorState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                ForEach(AnnotationColor.allCases) { c in
                    Button {
                        editor.color = c
                        if let id = editor.selectedID { editor.update(id: id) { $0.color = c } }
                    } label: {
                        Circle()
                            .fill(c.color)
                            .frame(width: 18, height: 18)
                            .overlay(Circle().strokeBorder(.primary.opacity(0.25)))
                            .overlay {
                                if editor.color == c {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(c == .white || c == .yellow ? .black : .white)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                }
            }
            HStack(spacing: 8) {
                Text("线宽").font(.system(size: 11)).foregroundStyle(.secondary)
                ForEach([2, 3, 5], id: \.self) { (w: Int) in
                    Button {
                        editor.lineWidth = CGFloat(w)
                        if let id = editor.selectedID { editor.update(id: id) { $0.lineWidth = CGFloat(w) } }
                    } label: {
                        Capsule().fill(.primary.opacity(editor.lineWidth == CGFloat(w) ? 0.9 : 0.35))
                            .frame(width: 22, height: CGFloat(w) + 1)
                            .frame(height: 18)
                    }
                    .buttonStyle(.plain)
                }
                Divider().frame(height: 14)
                Text("字号").font(.system(size: 11)).foregroundStyle(.secondary)
                ForEach([("小", CGFloat(13)), ("中", CGFloat(18)), ("大", CGFloat(26))], id: \.0) { label, size in
                    Button {
                        editor.fontSize = size
                        if let id = editor.selectedID { editor.update(id: id) { $0.fontSize = size } }
                    } label: {
                        Text(label)
                            .font(.system(size: 11, weight: editor.fontSize == size ? .bold : .regular))
                            .foregroundStyle(editor.fontSize == size ? .primary : .secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
    }
}

// MARK: - AI composer bar（招牌：框选下方直接和 AI 对话）

private struct AIComposerBar: View {
    @ObservedObject var session: CaptureSessionModel
    @ObservedObject private var ai: AIAnnotationSession
    @FocusState private var focused: Bool

    init(session: CaptureSessionModel) {
        self.session = session
        self.ai = session.ai
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(
                        LinearGradient(colors: [Color(red: 0.45, green: 0.75, blue: 1.0),
                                                Color(red: 0.75, green: 0.55, blue: 1.0)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing))

                TextField("让 AI 帮你标注：如“圈出登录按钮，并标注‘从这里进入’”", text: $ai.input)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.white)
                    .focused($focused)
                    .disabled(ai.isRunning)
                    .onSubmit(send)

                if ai.isRunning {
                    Button { ai.cancel() } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    .buttonStyle(.plain)
                    .help("停止")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(ai.input.trimmed.isEmpty
                                             ? Color.white.opacity(0.3)
                                             : Color(nsColor: .controlAccentColor))
                    }
                    .buttonStyle(.plain)
                    .disabled(ai.input.trimmed.isEmpty)
                    .help("发送")
                }
            }
            .padding(.horizontal, 11)
            .frame(height: 36)

            statusLine
        }
        .padding(.vertical, 4)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.black.opacity(0.86))
                if ai.isRunning {
                    CapsuleSweepCompat()
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(.white.opacity(0.12))
            }
            .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
        )
    }

    @ViewBuilder
    private var statusLine: some View {
        switch ai.phase {
        case .idle:
            EmptyView()
        case .running(let word):
            statusText(word + "…", color: .white.opacity(0.65))
        case .failed(let message):
            statusText(message, color: Color(red: 0.98, green: 0.62, blue: 0.32))
        case .done(let reply):
            statusText(reply, color: .white.opacity(0.75))
        }
    }

    private func statusText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(color)
            .lineLimit(3)
            .padding(.horizontal, 12)
            .padding(.bottom, 5)
            .textSelection(.enabled)
    }

    private func send() {
        guard let crop = session.crop, let sel = session.selection else { return }
        session.editor.editingTextID = nil
        ai.send(crop: crop, cropPointSize: sel.size, editor: session.editor)
    }
}

/// A soft light sweeping across the AI bar while it thinks (same visual
/// language as the dictation pill's 扫光, restated locally since that one is
/// file-private to Pill.swift).
private struct CapsuleSweepCompat: View {
    @State private var phase: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let bandW = w * 0.4
            LinearGradient(colors: [.clear, .white.opacity(0.10), .clear],
                           startPoint: .leading, endPoint: .trailing)
                .frame(width: bandW)
                .offset(x: -bandW + phase * (w + bandW))
                .blendMode(.plusLighter)
        }
        .allowsHitTesting(false)
        .onAppear {
            phase = 0
            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }
}

// MARK: - Toast

private struct ToastView: View {
    let text: String
    let canvas: CGSize

    var body: some View {
        Text(text)
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 9)
            .background(Color.black.opacity(0.78), in: Capsule())
            .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
            .frame(width: canvas.width, alignment: .center)
            .offset(y: canvas.height * 0.82)
            .allowsHitTesting(false)
            .transition(.opacity)
    }
}
