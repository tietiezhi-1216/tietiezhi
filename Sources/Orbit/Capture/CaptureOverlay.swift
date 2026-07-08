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

// MARK: - Beautify（导出美化：内边距 + 圆角 + 阴影 + 背景）

/// The backdrop behind a beautified shot. Shared by the live preview and export.
enum BeautifyBackground: String, CaseIterable, Identifiable {
    case light, dark, gradient, none

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .light:    return "浅"
        case .dark:     return "深"
        case .gradient: return "渐变"
        case .none:     return "透明"
        }
    }

    var isTransparent: Bool { self == .none }

    /// The fill used both on-screen and in the exported bitmap.
    var fill: AnyShapeStyle {
        switch self {
        case .light:    return AnyShapeStyle(Color(white: 0.94))
        case .dark:     return AnyShapeStyle(Color(white: 0.13))
        case .gradient: return AnyShapeStyle(LinearGradient(
            colors: [Color(red: 0.42, green: 0.52, blue: 0.96),
                     Color(red: 0.73, green: 0.46, blue: 0.96)],
            startPoint: .topLeading, endPoint: .bottomTrailing))
        case .none:     return AnyShapeStyle(Color.clear)
        }
    }
}

/// Resolved beautify frame geometry, passed into the exporter.
struct BeautifyParams {
    let background: BeautifyBackground
    let padding: CGFloat
    let corner: CGFloat
}

// MARK: - Session model

@MainActor
final class CaptureSessionModel: ObservableObject {
    enum Phase { case selecting, editing }

    @Published var phase: Phase = .selecting
    @Published var hoverPoint: CGPoint?
    @Published var hoverWindow: CGRect?
    /// The finer Accessibility-element frame under the cursor (view coords) — the
    /// snap target when available, falling back to `hoverWindow`.
    @Published var hoverElement: CGRect?
    @Published var dragRect: CGRect?
    @Published var selection: CGRect?
    @Published var toast: String?

    let frozen: CGImage
    let scale: CGFloat
    let canvasSize: CGSize        // screen size in points
    let screenFrame: CGRect       // target screen frame in Cocoa coords (for AX conversion)
    let windows: [SnapWindow]
    let editor: AnnotationEditorState
    let ai: AIAnnotationSession

    private let snapper = ElementSnapper()
    /// UI nodes inside the current selection (overlay-view coords), collected off
    /// the main thread — fed to the AI as precise anchors. Cleared when the crop
    /// is transformed (they'd no longer line up with the rotated/flipped image).
    private(set) var axNodes: [AXNode] = []
    private var axCollectSeq = 0

    /// Set when editing starts.
    @Published var crop: CGImage?
    @Published var pixelated: CGImage?
    var source = "region"

    /// The clean crop BEFORE any image adjust — adjustments always re-derive from
    /// this, so the 亮度/对比度/饱和度 sliders stay non-destructive.
    private var baseCrop: CGImage?

    /// Image-adjust (batch 3): sliders live in the bottom cluster and re-filter
    /// `crop` / `pixelated`. Defaults (0 / 1 / 1) mean "no change".
    @Published var adjustOpen = false
    @Published var brightness: Double = 0      // −0.5 … 0.5
    @Published var contrast: Double = 1        // 0.5 … 1.5
    @Published var saturation: Double = 1      // 0 … 2

    /// A non-default adjust means the on-screen selection must show the filtered
    /// crop (the editor otherwise shows the frozen passthrough).
    var imageAdjusted: Bool { brightness != 0 || contrast != 1 || saturation != 1 }

    /// True once the crop has been rotated / flipped — from then on it no longer
    /// matches the frozen desktop behind it, so the editor must paint the crop.
    @Published var transformed = false

    /// Whether the selection must render `crop` (adjust / rotate / flip diverged it
    /// from the frozen passthrough) rather than letting the frozen pixels show through.
    var showsCropOverlay: Bool { imageAdjusted || transformed || beautifyOn }

    /// User-dragged offset of the bottom control cluster (via its grip handle) —
    /// lets it be moved anywhere, e.g. when the selection hugs the screen bottom.
    @Published var clusterDragOffset: CGSize = .zero

    /// Beautify (导出美化): a padded, rounded, shadowed frame around the finished shot.
    @Published var beautifyOn = false
    @Published var beautifyBackground: BeautifyBackground = .light

    /// Padding around the shot when beautify is on — scales with the smaller side.
    var beautifyPadding: CGFloat {
        guard let sel = selection else { return 0 }
        return min(max(min(sel.width, sel.height) * 0.08, 22), 72)
    }

    var beautifyCorner: CGFloat { 12 }

    /// The outer frame rect (selection + padding) — dim cutout + live backdrop.
    var beautifyFrame: CGRect? {
        guard beautifyOn, let sel = selection else { return nil }
        let p = beautifyPadding
        return sel.insetBy(dx: -p, dy: -p)
    }

    /// Beautify geometry for the exporter (nil when off).
    var beautifyParams: BeautifyParams? {
        guard beautifyOn else { return nil }
        return BeautifyParams(background: beautifyBackground,
                              padding: beautifyPadding, corner: beautifyCorner)
    }

    var onCancel: (() -> Void)?
    var onFinish: ((CaptureFinishAction) -> Void)?
    /// Copy the annotated shot to the clipboard WITHOUT closing the editor.
    var onCopyStay: (() -> Void)?

    private var toastTask: Task<Void, Never>?

    init(frozen: CGImage, scale: CGFloat, canvasSize: CGSize, screenFrame: CGRect,
         windows: [SnapWindow], settings: SettingsStore, usage: UsageStore?) {
        self.frozen = frozen
        self.scale = scale
        self.canvasSize = canvasSize
        self.screenFrame = screenFrame
        self.windows = windows
        self.editor = AnnotationEditorState()
        self.ai = AIAnnotationSession(settings: settings, usage: usage)
    }

    // MARK: - Accessibility snapping / anchors

    /// Kick off an element lookup at a hovered view point; the result sets
    /// `hoverElement` (the finer snap target). `pids` are the candidate apps whose
    /// windows contain the point, front-to-back. Queries re-run as the cursor
    /// moves — crucially even INSIDE the current element, so hovering into a small
    /// nested control refines the snap instead of sticking to the outer container.
    /// (The cache makes these lookups pure local geometry, so a 2pt movement
    /// threshold is all the throttling needed.)
    private var lastSnapQuery = CGPoint(x: -1000, y: -1000)

    func requestElementSnap(at p: CGPoint, pids: [pid_t]) {
        guard p.distance(to: lastSnapQuery) > 2 else { return }
        lastSnapQuery = p
        snapper.request(viewPoint: p, pids: pids, screenFrame: screenFrame) { [weak self] frame in
            guard let self, self.phase == .selecting else { return }
            self.hoverElement = frame?.intersection(CGRect(origin: .zero, size: self.canvasSize))
        }
    }

    /// Scan all candidate apps' element trees into the snap cache (called once,
    /// right after the overlay appears + AX prewarm).
    func prescanElements() {
        var pids: [pid_t] = []
        for w in windows where !pids.contains(w.pid) { pids.append(w.pid) }
        snapper.prescan(pids: Array(pids.prefix(6)))
    }

    /// Candidate apps (front-to-back, deduped) whose windows contain a point.
    private func candidatePids(at p: CGPoint) -> [pid_t] {
        var pids: [pid_t] = []
        for w in windows where w.frame.contains(p) && !pids.contains(w.pid) {
            pids.append(w.pid)
        }
        return Array(pids.prefix(4))
    }

    /// Collect the UI nodes inside the current selection off the main thread. Runs
    /// on `beginEditing` and after a re-frame settles; stored in view coords.
    /// Candidates are tried front-to-back until one yields nodes (skips another
    /// app's invisible helper window that happens to cover the selection).
    func collectAXNodes() {
        guard let sel = selection, AXScanner.isAvailable else {
            axNodes = []
            return
        }
        let pids = candidatePids(at: CGPoint(x: sel.midX, y: sel.midY))
        guard !pids.isEmpty else {
            axNodes = []
            return
        }
        let axRect = AXScanner.viewRectToAX(sel, screenFrame: screenFrame)
        let frame = screenFrame
        axCollectSeq += 1
        let token = axCollectSeq
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var nodes: [AXNode] = []
            for pid in pids {
                nodes = AXScanner.nodes(pid: pid, inGlobalRect: axRect).map {
                    AXNode(role: $0.role, label: $0.label,
                           frame: AXScanner.axRectToView($0.frame, screenFrame: frame))
                }
                if !nodes.isEmpty { break }
            }
            DispatchQueue.main.async {
                guard let self, token == self.axCollectSeq else { return }
                self.axNodes = nodes
                CaptureLog.log("AX节点收集：\(nodes.count) 个（候选 \(pids)）")
            }
        }
    }

    /// The nodes intersecting the current selection, in CROP-LOCAL points — handed
    /// to the AI as precise element anchors.
    func axAnchorsForAI() -> [AXNode] {
        guard let sel = selection, !transformed else { return [] }
        let bounds = CGRect(origin: .zero, size: sel.size)
        return axNodes.compactMap { n in
            let local = CGRect(x: n.frame.minX - sel.minX, y: n.frame.minY - sel.minY,
                               width: n.frame.width, height: n.frame.height)
            let clipped = local.intersection(bounds)
            guard clipped.width > 3, clipped.height > 3 else { return nil }
            return AXNode(role: n.role, label: n.label, frame: clipped)
        }
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
        baseCrop = cropped
        crop = cropped
        pixelated = cropped.pixelated(scale: scale)
        brightness = 0; contrast = 1; saturation = 1
        adjustOpen = false
        transformed = false
        clusterDragOffset = .zero
        dragRect = nil
        hoverWindow = nil
        hoverElement = nil
        phase = .editing
        collectAXNodes()
    }

    /// Rotate the whole canvas 90° clockwise: the crop, its clean base, and every
    /// annotation (and the undo history) turn together, and the selection's W/H swap.
    func rotateCW() {
        guard let sel = selection, let base = baseCrop, let rBase = base.rotated90CW() else { return }
        let oldSize = sel.size
        baseCrop = rBase
        applyImageAdjust()            // re-derive crop + pixelated from the rotated base

        // Selection W/H swap; keep the top-left, clamped on-screen.
        let newSize = CGSize(width: oldSize.height, height: oldSize.width)
        let x = max(0, min(sel.minX, max(0, canvasSize.width - newSize.width)))
        let y = max(0, min(sel.minY, max(0, canvasSize.height - newSize.height)))
        selection = CGRect(x: x, y: y, width: newSize.width, height: newSize.height)

        // Same 90°-CW map applied to pixels: (x, y) → (H − y, x), H = old height.
        let h = oldSize.height
        editor.transformAll { CGPoint(x: h - $0.y, y: $0.x) }
        transformed = true
        axNodes = []   // node frames no longer line up with the rotated crop
    }

    /// Mirror the whole canvas horizontally or vertically — crop, base and every
    /// annotation (+ undo history) flip together; the selection rect is unchanged.
    func flip(horizontal: Bool) {
        guard let sel = selection, let base = baseCrop,
              let fBase = base.flipped(horizontal: horizontal) else { return }
        baseCrop = fBase
        applyImageAdjust()            // re-derive crop + pixelated from flipped base
        let w = sel.size.width, h = sel.size.height
        editor.transformAll {
            horizontal ? CGPoint(x: w - $0.x, y: $0.y) : CGPoint(x: $0.x, y: h - $0.y)
        }
        transformed = true
        axNodes = []
    }

    /// Re-frame the selection after the first capture: re-crop the region out of
    /// the frozen desktop (annotations keep their window-relative positions). The
    /// live drag skips the mosaic re-block and regenerates it on release. Disabled
    /// once rotated/flipped — that content can't be re-cropped from the frozen frame.
    func reframe(to rect: CGRect, keepingSize: Bool = false, regeneratePixelated: Bool = true) {
        guard !transformed else { return }
        var target = rect
        if keepingSize {   // move: clamp the origin, don't shrink at the screen edge
            let x = min(max(0, rect.minX), max(0, canvasSize.width - rect.width))
            let y = min(max(0, rect.minY), max(0, canvasSize.height - rect.height))
            target = CGRect(x: x, y: y, width: rect.width, height: rect.height)
        }
        let clamped = target.intersection(CGRect(origin: .zero, size: canvasSize)).integral
        guard clamped.width >= 20, clamped.height >= 20 else { return }
        guard let cropped = frozen.cropping(toPointRect: clamped, scale: scale) else { return }
        selection = clamped
        baseCrop = cropped
        applyImageAdjust(regeneratePixelated: regeneratePixelated)   // keeps current brightness etc.
        if regeneratePixelated { collectAXNodes() }   // re-scan nodes once the frame settles
    }

    /// Re-derive `crop` (and, unless skipped, the mosaic source `pixelated`) from
    /// the clean base with the current sliders. During a continuous slider drag
    /// the caller skips `pixelated` — the GPU colour filter is cheap, but the
    /// nearest-neighbour re-block isn't — and regenerates it once on release.
    func applyImageAdjust(regeneratePixelated: Bool = true) {
        guard let base = baseCrop else { return }
        let out = imageAdjusted
            ? (base.adjusted(brightness: brightness, contrast: contrast, saturation: saturation) ?? base)
            : base
        crop = out
        if regeneratePixelated { pixelated = out.pixelated(scale: scale) }
    }

    func resetImageAdjust() {
        brightness = 0; contrast = 1; saturation = 1
        applyImageAdjust()
    }

    /// Back to the selecting phase to reframe. The crop, marks and AI thread all
    /// belonged to the old region, so they're discarded.
    func restartSelection() {
        editor.annotations.removeAll()
        editor.selectedID = nil
        editor.editingTextID = nil
        editor.tool = .select
        ai.reset()
        selection = nil
        crop = nil
        pixelated = nil
        baseCrop = nil
        brightness = 0; contrast = 1; saturation = 1
        adjustOpen = false
        transformed = false
        beautifyOn = false
        clusterDragOffset = .zero
        axNodes = []
        dragRect = nil
        hoverWindow = nil
        hoverElement = nil
        phase = .selecting
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

    /// Right-click hook (return true = swallow). Intercepted in `sendEvent` — the
    /// mandatory dispatch path for every event routed to this window — because a
    /// local event monitor proved unreliable for right-clicks on this panel.
    var onRightMouseDown: (() -> Bool)?

    override func sendEvent(_ event: NSEvent) {
        if event.type == .rightMouseDown, onRightMouseDown?() == true { return }
        super.sendEvent(event)
    }
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
        // Layered right-click (PixPin-style): editing → back to re-select the
        // region; selecting → cancel the capture entirely.
        panel.onRightMouseDown = { [weak self] in
            guard let self else { return false }
            switch self.session.phase {
            case .editing:
                CaptureLog.log("右键 → 返回重新框选")
                self.session.restartSelection()
            case .selecting:
                CaptureLog.log("右键 → 取消截图")
                self.session.onCancel?()
            }
            return true
        }
        self.panel = panel
        // The capture chord usually fires while Orbit is in the BACKGROUND (the
        // user is in another app). A plain makeKeyAndOrderFront from a background,
        // non-activating app does not reliably bring a borderless panel to the
        // front or make it key — so activate the app AND force the panel front.
        // ORDER MATTERS: the panel must already cover the screen BEFORE activation,
        // because activate() raises Orbit's other windows (main chat window) — with
        // the opaque panel on top first, that raise happens invisibly (no flash).
        panel.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeKey()
        CaptureLog.log("遮罩已显示 screen=\(screen.frame) visible=\(panel.isVisible) key=\(panel.isKeyWindow)")
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
        // Snap target: an explicit drag wins, else the finer AX element, else window.
        let active = session.dragRect ?? session.hoverElement ?? session.hoverWindow

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
                        if session.dragRect == nil { updateHover(at: p) }
                    case .ended:
                        session.hoverPoint = nil
                    }
                }
        }
    }

    /// Window under the cursor (instant) + an async element hit-test (finer snap).
    /// All windows containing the point become candidates, front-to-back — the
    /// snapper skips apps whose window here is an invisible helper.
    private func updateHover(at p: CGPoint) {
        let containing = session.windows.filter { $0.frame.contains(p) }
        session.hoverWindow = containing.first?.frame
            .intersection(CGRect(origin: .zero, size: session.canvasSize))
        if containing.isEmpty {
            session.hoverElement = nil
        } else {
            var pids: [pid_t] = []
            for w in containing where !pids.contains(w.pid) { pids.append(w.pid) }
            session.requestElementSnap(at: p, pids: Array(pids.prefix(4)))
        }
    }

    private var selectGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let a = value.startLocation, b = value.location
                session.hoverPoint = b
                if a.distance(to: b) > 4 {
                    session.hoverElement = nil          // a real drag overrides element snap
                    session.dragRect = CGRect(x: min(a.x, b.x), y: min(a.y, b.y),
                                              width: abs(b.x - a.x), height: abs(b.y - a.y))
                }
            }
            .onEnded { value in
                if let rect = session.dragRect {
                    session.beginEditing(rect, source: "region")
                } else if let element = session.hoverElement {
                    session.beginEditing(element, source: "element")
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

/// The interactive selection frame in the editing phase: an accent border, 8
/// resize handles, and thin edge strips you can drag to move the whole region.
/// Every change re-crops via `session.reframe`. Hidden while beautify is on; the
/// handles/strips are inert once the crop is rotated/flipped (can't re-crop then).
private struct SelectionFrame: View {
    @ObservedObject var session: CaptureSessionModel
    let selection: CGRect
    @State private var startRect: CGRect?

    private enum Handle: CaseIterable { case tl, t, tr, r, br, b, bl, l }
    private var accent: Color { Color(nsColor: .controlAccentColor) }
    private var adjustable: Bool { !session.transformed }

    var body: some View {
        if session.beautifyOn {
            EmptyView()
        } else {
            ZStack(alignment: .topLeading) {
                Rectangle()
                    .strokeBorder(accent, lineWidth: 2)
                    .background(Rectangle().strokeBorder(.white.opacity(0.5), lineWidth: 0.5).padding(-1))
                    .frame(width: max(1, selection.width), height: max(1, selection.height))
                    .offset(x: selection.minX, y: selection.minY)
                    .allowsHitTesting(false)

                if adjustable {
                    ForEach(Handle.allCases, id: \.self) { handleDot($0) }
                }
            }
        }
    }

    // MARK: Resize (drag a handle; the opposite edges stay put). Moving the whole
    // region is done by dragging the interior — see AnnotationCanvasView.onSelectionMove.

    private func handleDot(_ h: Handle) -> some View {
        let p = point(h)
        return ZStack {
            Color.white.opacity(0.001).frame(width: 22, height: 22)   // generous hit area
            Circle().fill(.white)
                .overlay(Circle().strokeBorder(accent, lineWidth: 1.5))
                .frame(width: 11, height: 11)
        }
        .contentShape(Rectangle())
        .offset(x: p.x - 11, y: p.y - 11)
        .gesture(
            // Global coordinate space: the translation is screen-stable, immune to
            // this handle moving as the selection resizes under it.
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { v in
                    if startRect == nil { startRect = selection }
                    session.reframe(to: resized(startRect ?? selection, h, v.translation),
                                    regeneratePixelated: false)
                }
                .onEnded { _ in
                    if let r = session.selection { session.reframe(to: r) }
                    startRect = nil
                }
        )
    }

    private func point(_ h: Handle) -> CGPoint {
        let s = selection
        switch h {
        case .tl: return CGPoint(x: s.minX, y: s.minY)
        case .t:  return CGPoint(x: s.midX, y: s.minY)
        case .tr: return CGPoint(x: s.maxX, y: s.minY)
        case .r:  return CGPoint(x: s.maxX, y: s.midY)
        case .br: return CGPoint(x: s.maxX, y: s.maxY)
        case .b:  return CGPoint(x: s.midX, y: s.maxY)
        case .bl: return CGPoint(x: s.minX, y: s.maxY)
        case .l:  return CGPoint(x: s.minX, y: s.midY)
        }
    }

    private func resized(_ r: CGRect, _ h: Handle, _ t: CGSize) -> CGRect {
        var minX = r.minX, minY = r.minY, maxX = r.maxX, maxY = r.maxY
        switch h {
        case .tl: minX += t.width; minY += t.height
        case .t:  minY += t.height
        case .tr: maxX += t.width; minY += t.height
        case .r:  maxX += t.width
        case .br: maxX += t.width; maxY += t.height
        case .b:  maxY += t.height
        case .bl: minX += t.width; maxY += t.height
        case .l:  minX += t.width
        }
        return CGRect(x: min(minX, maxX), y: min(minY, maxY),
                      width: abs(maxX - minX), height: abs(maxY - minY))
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
    @ObservedObject private var editor: AnnotationEditorState
    @State private var clusterSize: CGSize = .zero
    @State private var moveStartRect: CGRect?

    init(session: CaptureSessionModel) {
        self.session = session
        self.editor = session.editor
    }

    /// Drag empty interior in select mode → move the whole selection region. The
    /// mosaic source is regenerated only on release (see `reframe`).
    private func handleSelectionMove(_ phase: SelectionMovePhase, from sel: CGRect) {
        switch phase {
        case .began:
            moveStartRect = sel
        case .changed(let t):
            guard let start = moveStartRect else { return }
            session.reframe(to: start.offsetBy(dx: t.width, dy: t.height),
                            keepingSize: true, regeneratePixelated: false)
        case .ended:
            if let r = session.selection { session.reframe(to: r, keepingSize: true) }
            moveStartRect = nil
        }
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Beautify pushes the un-dimmed cutout out to the padded frame.
            DimLayer(canvas: session.canvasSize, cutout: session.beautifyFrame ?? session.selection)

            if let sel = session.selection {
                // Beautify backdrop (padded, rounded) — the crop casts its shadow
                // onto this, matching the export composition.
                if session.beautifyOn, let frame = session.beautifyFrame {
                    RoundedRectangle(cornerRadius: session.beautifyCorner + session.beautifyPadding * 0.4,
                                     style: .continuous)
                        .fill(session.beautifyBackground.fill)
                        .frame(width: frame.width, height: frame.height)
                        .offset(x: frame.minX, y: frame.minY)
                        .allowsHitTesting(false)
                }

                // The editor shows the frozen desktop passthrough; once the crop
                // diverges (adjust / rotate / flip / beautify) paint the crop over
                // the selection so it's visible live (and matches the export). Under
                // beautify the crop is rounded + shadowed onto the backdrop.
                if session.showsCropOverlay, let crop = session.crop {
                    Image(decorative: crop, scale: session.scale)
                        .resizable()
                        .frame(width: sel.width, height: sel.height)
                        .clipShape(RoundedRectangle(
                            cornerRadius: session.beautifyOn ? session.beautifyCorner : 0,
                            style: .continuous))
                        .shadow(color: .black.opacity(session.beautifyOn ? 0.28 : 0),
                                radius: session.beautifyOn ? session.beautifyPadding * 0.42 : 0,
                                y: session.beautifyOn ? session.beautifyPadding * 0.2 : 0)
                        .offset(x: sel.minX, y: sel.minY)
                        .allowsHitTesting(false)
                }

                SizeLabel(rect: sel, canvas: session.canvasSize)

                AnnotationCanvasView(editor: session.editor,
                                     size: sel.size,
                                     pixelated: session.pixelated,
                                     displayScale: session.scale,
                                     onSelectionMove: { handleSelectionMove($0, from: sel) })
                    .offset(x: sel.minX, y: sel.minY)

                // Draggable frame: border + 8 resize handles on top of the canvas
                // (moving the whole region is done by dragging the interior above).
                SelectionFrame(session: session, selection: sel)

                if editor.layersOpen { LayersPanel(session: session, selection: sel) }
                RightToolbar(session: session, selection: sel)

                controlCluster(selection: sel)
            }
        }
    }

    /// The toolbar hugs its own content; the AI bar gets a comfortable width.
    ///
    /// Right-alignment is DETERMINISTIC: the cluster sits `.topTrailing` inside a
    /// container whose trailing edge IS the selection's right edge (the same line
    /// the right rail hangs off) — no dependence on measuring the cluster's own
    /// width (the measure-then-offset approach positioned with a stale/fallback
    /// width, leaving the toolbar overhanging the selection). Height is still
    /// measured, but only for the fits-below/above flip.
    @ViewBuilder
    private func controlCluster(selection: CGRect) -> some View {
        let aiWidth = min(max(selection.width, 380), session.canvasSize.width - 24, 560)
        let right = min(max(selection.maxX, 396), session.canvasSize.width - 8)
        let containerW = right - 8
        VStack(alignment: .trailing, spacing: 8) {
            CaptureToolbar(session: session)
            // Contextual properties only when something can use them (a draw tool
            // is active or an annotation is selected) — in plain select mode the
            // row would just crowd the AI composer.
            if editor.activeKind != nil {
                PropertyBar(editor: editor)
            }
            if session.adjustOpen {
                AdjustBar(session: session)
                    .frame(width: aiWidth)
            }
            if session.beautifyOn {
                BeautifyBar(session: session)
                    .frame(width: aiWidth)
            }
            AIComposerBar(session: session)
                .frame(width: aiWidth)
        }
        .fixedSize()
        .background(
            GeometryReader { geo in
                Color.clear.preference(key: ClusterSizeKey.self, value: geo.size)
            }
        )
        .onPreferenceChange(ClusterSizeKey.self) { clusterSize = $0 }
        .frame(width: containerW, alignment: .topTrailing)
        .offset(clusterOffset(selection: selection, containerW: containerW))
    }

    private func clusterOffset(selection: CGRect, containerW: CGFloat) -> CGSize {
        let h = clusterSize.height > 0 ? clusterSize.height : 120
        var y = selection.maxY + 10
        if y + h > session.canvasSize.height - 10 {
            y = selection.minY - h - 10                              // no room below → above
            if y < 10 { y = session.canvasSize.height - h - 10 }     // nor above → pin to screen bottom
        }
        y = max(10, y)
        let fy = min(max(8, y + session.clusterDragOffset.height), session.canvasSize.height - h - 8)
        // Horizontal: the container's leading edge starts at 8; the grip drag moves
        // it, clamped so a usable chunk of the cluster stays on-screen.
        let rawX = 8 + session.clusterDragOffset.width
        let fx = min(max(140 - containerW, rawX), session.canvasSize.width - containerW - 8)
        return CGSize(width: fx, height: fy)
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

    init(session: CaptureSessionModel) {
        self.session = session
        self.editor = session.editor
    }

    private static let tools: [AnnotationKind] = [
        .arrow, .line, .rect, .ellipse, .freehand, .text, .badge, .highlight, .mosaic, .spotlight,
    ]

    /// Cluster offset at the start of a grip drag (global-space gesture, so the
    /// cluster moving under the cursor can't feed back into the translation).
    @State private var gripDragBase: CGSize?

    var body: some View {
        HStack(spacing: 3) {
            // Grip: drag the whole control cluster anywhere (e.g. when the
            // selection hugs the screen bottom and the bars would collide).
            Image(systemName: "circle.grid.2x2")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.45))
                .frame(width: 18, height: 28)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 1, coordinateSpace: .global)
                        .onChanged { v in
                            if gripDragBase == nil { gripDragBase = session.clusterDragOffset }
                            let base = gripDragBase ?? .zero
                            session.clusterDragOffset = CGSize(width: base.width + v.translation.width,
                                                               height: base.height + v.translation.height)
                        }
                        .onEnded { _ in gripDragBase = nil }
                )
                .onHover { $0 ? NSCursor.openHand.set() : NSCursor.arrow.set() }
                .help("拖动移动工具栏")

            toolButton(icon: "cursorarrow", help: "选择 / 移动", active: editor.tool == .select) {
                editor.tool = .select
            }
            ForEach(Self.tools) { kind in
                toolButton(icon: kind.symbol, help: kind.displayName,
                           active: editor.tool == .draw(kind)) {
                    editor.tool = .draw(kind)
                }
            }
            toolButton(icon: "eraser", help: "橡皮擦（点/拖以擦除标注）",
                       active: editor.tool == .erase) { editor.tool = .erase }

            divider

            toolButton(icon: "arrow.uturn.backward", help: "撤销 ⌘Z",
                       disabled: !editor.canUndo) { editor.undo() }
            toolButton(icon: "arrow.uturn.forward", help: "重做 ⇧⌘Z",
                       disabled: !editor.canRedo) { editor.redo() }

            divider

            toolButton(icon: "rectangle.stack", help: "图层", active: editor.layersOpen) {
                editor.layersOpen.toggle()
            }
            toolButton(icon: "text.viewfinder", help: "提取文字（OCR）") { runOCR() }
            toolButton(icon: "pin", help: "贴到屏幕") { session.onFinish?(.pin) }
            toolButton(icon: "doc.on.doc", help: "复制到剪贴板（继续编辑）") { session.onCopyStay?() }
            toolButton(icon: "square.and.arrow.down", help: "另存为… ⌘S") { session.onFinish?(.save) }

            Spacer(minLength: 10)

            toolButton(icon: "xmark", help: "取消 Esc") { session.onCancel?() }
            Button { session.onFinish?(.copy) } label: {
                Label("完成", systemImage: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 11)
                    .frame(height: 26)
                    .background(Color(nsColor: .controlAccentColor), in: Capsule())
                    .contentShape(Capsule())
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
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(active ? Color.white.opacity(0.92) : .clear)
                )
                .contentShape(Rectangle())   // whole cell is clickable, not just the glyph
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

/// A compact drag- AND scroll-adjustable value control (线宽 / 圆角 / 字号 / 箭头) —
/// the "size" the user scrubs continuously, not a handful of presets. Wraps a tiny
/// AppKit view because SwiftUI has no scroll-wheel hook for a plain control.
struct ScrubSlider: NSViewRepresentable {
    @Binding var value: Double
    var range: ClosedRange<Double>
    var step: Double = 1

    func makeNSView(context: Context) -> ScrubSliderView {
        let v = ScrubSliderView()
        v.configure(range: range, step: step) { value = $0 }
        v.value = value
        return v
    }

    func updateNSView(_ v: ScrubSliderView, context: Context) {
        v.range = range
        v.step = step
        if v.value != value { v.value = value }
    }
}

final class ScrubSliderView: NSView {
    var value: Double = 0 { didSet { needsDisplay = true } }
    var range: ClosedRange<Double> = 0...1
    var step: Double = 1
    private var onChange: ((Double) -> Void)?

    func configure(range: ClosedRange<Double>, step: Double, onChange: @escaping (Double) -> Void) {
        self.range = range; self.step = step; self.onChange = onChange
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 74, height: 22) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let inset: CGFloat = 6
        let midY = bounds.midY
        let x0 = inset, w = max(1, bounds.width - inset * 2)
        let f = CGFloat((value - range.lowerBound) / max(range.upperBound - range.lowerBound, 0.0001))
        let kx = x0 + w * max(0, min(1, f))
        NSColor.white.withAlphaComponent(0.22).setFill()
        NSBezierPath(roundedRect: NSRect(x: x0, y: midY - 1.5, width: w, height: 3),
                     xRadius: 1.5, yRadius: 1.5).fill()
        NSColor.controlAccentColor.setFill()
        NSBezierPath(roundedRect: NSRect(x: x0, y: midY - 1.5, width: max(0, kx - x0), height: 3),
                     xRadius: 1.5, yRadius: 1.5).fill()
        NSColor.white.setFill()
        NSBezierPath(ovalIn: NSRect(x: kx - 5, y: midY - 5, width: 10, height: 10)).fill()
    }

    private func commit(_ v: Double) {
        let clamped = min(max(range.lowerBound, (v / step).rounded() * step), range.upperBound)
        if clamped != value { value = clamped; onChange?(clamped) }
    }

    private func setFromX(_ x: CGFloat) {
        let inset: CGFloat = 6
        let f = Double(max(0, min(1, (x - inset) / max(bounds.width - inset * 2, 1))))
        commit(range.lowerBound + f * (range.upperBound - range.lowerBound))
    }

    override func mouseDown(with e: NSEvent) { setFromX(convert(e.locationInWindow, from: nil).x) }
    override func mouseDragged(with e: NSEvent) { setFromX(convert(e.locationInWindow, from: nil).x) }

    override func scrollWheel(with e: NSEvent) {
        let d = e.hasPreciseScrollingDeltas ? e.scrollingDeltaY : e.deltaY
        guard d != 0 else { return }
        commit(value + (d > 0 ? step : -step))   // wheel up = larger
    }
}

/// The always-visible property bar under the toolbar. Its left half is
/// contextual — fill / dash / corner / width / arrow / font controls relevant to
/// the active tool or selection — and the colour palette anchors the right.
/// Rendered inline (not a system popover) so it's reliable over the screen panel.
private struct PropertyBar: View {
    @ObservedObject var editor: AnnotationEditorState

    /// The kind whose controls we show: the selection wins, else the draw tool.
    private var kind: AnnotationKind? { editor.activeKind }
    private var showsFill: Bool { kind == .rect || kind == .ellipse }
    private var showsDash: Bool { kind == .rect || kind == .ellipse || kind == .line }
    private var showsCorner: Bool { kind == .rect || kind == .spotlight }
    private var showsArrow: Bool { kind == .arrow }
    private var showsWidth: Bool {
        guard let kind else { return true }   // select mode, nothing picked → generic
        return [.arrow, .line, .rect, .ellipse, .freehand].contains(kind)
    }
    private var showsFont: Bool { kind == .text || kind == .badge }

    var body: some View {
        Group {
            if kind == .mosaic {
                Text("拖拽覆盖要打码的区域，可叠加多块")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.white.opacity(0.5))
                    .frame(maxWidth: .infinity)
            } else {
                HStack(spacing: 9) {
                    if showsFill { fillSection; divider }
                    if showsDash { dashSection; divider }
                    if showsCorner { cornerSection; divider }
                    if showsWidth { widthSection; divider }
                    if showsArrow { arrowSection; divider }
                    if showsFont { fontSection; divider }
                    colorSection
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
        .fixedSize(horizontal: true, vertical: false)
        .overlayBarChrome()
    }

    // MARK: Sections

    private var fillSection: some View {
        HStack(spacing: 3) {
            iconToggle("square", on: !editor.filled, help: "空心") { editor.setFilled(false) }
            iconToggle("square.fill", on: editor.filled, help: "实心") { editor.setFilled(true) }
        }
    }

    private var dashSection: some View {
        HStack(spacing: 3) {
            ForEach(LineDashStyle.allCases) { style in
                Button { editor.setDash(style) } label: {
                    ZStack {
                        RoundedRectangle(cornerRadius: 5)
                            .fill(editor.dash == style ? Color.white.opacity(0.16) : .clear)
                            .frame(width: 32, height: 26)
                        DashLine()
                            .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round,
                                                       dash: style.pattern(for: 2) ?? []))
                            .foregroundStyle(.white.opacity(editor.dash == style ? 0.95 : 0.55))
                            .frame(width: 20, height: 2)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(style.displayName)
            }
        }
    }

    private var cornerSection: some View {
        scrub("圆角", get: { editor.cornerRadius }, set: { editor.setCornerRadius($0) }, range: 0...40)
    }

    private var widthSection: some View {
        scrub("线宽", get: { editor.lineWidth }, set: { editor.setLineWidth($0) }, range: 1...20)
    }

    /// Arrows also expose the head style + a head-size scrub (箭头类型 / 箭头粗细).
    private var arrowSection: some View {
        HStack(spacing: 7) {
            HStack(spacing: 3) {
                ForEach(ArrowType.allCases) { t in
                    iconToggle(t.symbol, on: editor.arrowType == t, help: t.displayName) {
                        editor.setArrowType(t)
                    }
                }
            }
            scrub("箭头", get: { editor.arrowHeadScale }, set: { editor.setArrowHeadScale($0) },
                  range: 0.5...2.5, step: 0.1, format: { String(format: "%.1f×", $0) })
        }
    }

    private var fontSection: some View {
        scrub("字号", get: { editor.fontSize }, set: { editor.setFontSize($0) }, range: 10...48)
    }

    private var colorSection: some View {
        HStack(spacing: 6) {
            ForEach(AnnotationColor.allCases) { c in
                Button { editor.applyPreset(c) } label: {
                    Circle()
                        .fill(c.color)
                        .frame(width: 17, height: 17)
                        .overlay(Circle().strokeBorder(.white.opacity(0.35)))
                        .overlay {
                            if editor.colorHex == nil && editor.color == c {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(c == .white || c == .yellow ? .black : .white)
                            }
                        }
                        .frame(width: 23, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(c.rawValue)
            }
            HueBar(editor: editor)
                .frame(width: 88, height: 15)
                .help("自定义颜色（拖动取色）")
        }
    }

    // MARK: Small helpers

    private func label(_ text: String) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
    }

    /// A compact drag/scroll size control with a numeric readout.
    private func scrub(_ title: String, get: @escaping () -> CGFloat, set: @escaping (CGFloat) -> Void,
                       range: ClosedRange<Double>, step: Double = 1,
                       format: @escaping (CGFloat) -> String = { "\(Int($0))" }) -> some View {
        HStack(spacing: 5) {
            label(title)
            ScrubSlider(value: Binding(get: { Double(get()) }, set: { set(CGFloat($0)) }),
                        range: range, step: step)
                .frame(width: 74, height: 22)
            Text(format(get()))
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
                .frame(width: 30, alignment: .leading)
        }
    }

    private func iconToggle(_ icon: String, on: Bool, help: String,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(on ? Color.black.opacity(0.85) : .white.opacity(0.85))
                .frame(width: 26, height: 26)
                .background(RoundedRectangle(cornerRadius: 5)
                    .fill(on ? Color.white.opacity(0.92) : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private var divider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1, height: 18)
    }
}

/// A short horizontal line — the dash-style previews stroke it with each pattern.
private struct DashLine: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.width, y: rect.midY))
        return p
    }
}

// MARK: - Right rail（画布级操作：图像调整 / 重新框选）

/// The vertical rail hugging the selection's right edge — canvas-level actions
/// that aren't per-annotation. Falls back to the left edge when there's no room.
private struct RightToolbar: View {
    @ObservedObject var session: CaptureSessionModel
    let selection: CGRect

    private let buttonSize: CGFloat = 30

    var body: some View {
        VStack(spacing: 4) {
            railButton(icon: "wand.and.stars", help: "导出美化（内边距/圆角/阴影/背景）",
                       active: session.beautifyOn) { session.beautifyOn.toggle() }
            railButton(icon: "slider.horizontal.3", help: "图像调整（亮度/对比度/饱和度）",
                       active: session.adjustOpen) { session.adjustOpen.toggle() }
            railButton(icon: "rotate.right", help: "顺时针旋转 90°") { session.rotateCW() }
            railButton(icon: "arrow.left.and.right", help: "水平翻转") { session.flip(horizontal: true) }
            railButton(icon: "arrow.up.and.down", help: "垂直翻转") { session.flip(horizontal: false) }
            railButton(icon: "arrow.counterclockwise", help: "重新框选") {
                session.restartSelection()
            }
        }
        .padding(5)
        .overlayBarChrome()
        .fixedSize()
        .offset(railOffset)
    }

    private var railOffset: CGSize {
        let buttonCount: CGFloat = 6
        let barW = buttonSize + 10
        let barH = buttonSize * buttonCount + 4 * (buttonCount - 1) + 10
        var x = selection.maxX + 8
        if x + barW > session.canvasSize.width - 6 { x = selection.minX - barW - 8 }
        x = min(max(6, x), session.canvasSize.width - barW - 6)
        let y = min(max(6, selection.minY), session.canvasSize.height - barH - 6)
        return CGSize(width: x, height: y)
    }

    private func railButton(icon: String, help: String, active: Bool = false,
                            action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(active ? Color.black.opacity(0.85) : .white.opacity(0.9))
                .frame(width: buttonSize, height: buttonSize)
                .background(RoundedRectangle(cornerRadius: 7)
                    .fill(active ? Color.white.opacity(0.92) : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// The 亮度/对比度/饱和度 slider row, shown in the bottom cluster when the rail's
/// 调整 toggle is on. Live-filters the crop; the mosaic source is regenerated on
/// slider release only (see `applyImageAdjust`).
private struct AdjustBar: View {
    @ObservedObject var session: CaptureSessionModel

    var body: some View {
        HStack(spacing: 14) {
            slider(icon: "sun.max", value: $session.brightness, range: -0.5...0.5, help: "亮度")
            slider(icon: "circle.righthalf.filled", value: $session.contrast, range: 0.5...1.5, help: "对比度")
            slider(icon: "drop.halffull", value: $session.saturation, range: 0...2, help: "饱和度")
            Button { session.resetImageAdjust() } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(session.imageAdjusted ? .white.opacity(0.85) : .white.opacity(0.3))
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!session.imageAdjusted)
            .help("复位")
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .overlayBarChrome()
    }

    private func slider(icon: String, value: Binding<Double>,
                        range: ClosedRange<Double>, help: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.7))
                .frame(width: 16)
            // Custom binding: filter live (skip the mosaic re-block) on every tick.
            Slider(value: Binding(get: { value.wrappedValue },
                                  set: { value.wrappedValue = $0
                                         session.applyImageAdjust(regeneratePixelated: false) }),
                   in: range) { editing in
                if !editing { session.applyImageAdjust() }   // release → regen mosaic source
            }
            .controlSize(.small)
            .tint(Color(nsColor: .controlAccentColor))
        }
        .frame(minWidth: 120)
        .help(help)
    }
}

/// The 背景 picker for beautify — shown in the bottom cluster when 美化 is on.
private struct BeautifyBar: View {
    @ObservedObject var session: CaptureSessionModel

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wand.and.stars")
                .font(.system(size: 12)).foregroundStyle(.white.opacity(0.7))
            Text("背景").font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
            ForEach(BeautifyBackground.allCases) { bg in
                Button { session.beautifyBackground = bg } label: {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(bg.fill)
                        .frame(width: 26, height: 22)
                        .overlay {
                            if bg.isTransparent {
                                Image(systemName: "circle.slash")
                                    .font(.system(size: 11)).foregroundStyle(.white.opacity(0.55))
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .strokeBorder(session.beautifyBackground == bg
                                          ? Color(nsColor: .controlAccentColor) : .white.opacity(0.25),
                                          lineWidth: session.beautifyBackground == bg ? 2 : 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(bg.displayName)
            }
            Spacer(minLength: 0)
            Text("导出时加内边距 · 圆角 · 阴影")
                .font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.4))
        }
        .padding(.horizontal, 14)
        .frame(height: 42)
        .overlayBarChrome()
    }
}

// MARK: - Layers panel（图层：选中 / 调整层序 / 删除）

/// A floating panel listing every annotation front-first — click to select, the
/// chevrons reorder z (array order = draw order), trash deletes. Hugs the
/// selection's left edge, falling inside when there's no room.
private struct LayersPanel: View {
    @ObservedObject var session: CaptureSessionModel
    @ObservedObject private var editor: AnnotationEditorState
    let selection: CGRect

    init(session: CaptureSessionModel, selection: CGRect) {
        self.session = session
        self.editor = session.editor
        self.selection = selection
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("图层").font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Spacer()
                Button { editor.layersOpen = false } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white.opacity(0.6))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)

            if editor.annotations.isEmpty {
                Text("还没有标注").font(.system(size: 11)).foregroundStyle(.white.opacity(0.4))
                    .padding(.horizontal, 10).padding(.bottom, 9)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(editor.annotations.reversed()) { a in row(a) }   // front-most first
                    }
                    .padding(.horizontal, 6).padding(.bottom, 6)
                }
                .frame(maxHeight: 220)
            }
        }
        .frame(width: 184)
        .overlayBarChrome()
        .offset(panelOffset)
    }

    private func row(_ a: Annotation) -> some View {
        let selected = editor.selectedID == a.id
        return HStack(spacing: 7) {
            Image(systemName: a.kind.symbol).font(.system(size: 11))
                .foregroundStyle(a.displayColor).frame(width: 16)
            Text(a.layerTitle).font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.9)).lineLimit(1)
            Spacer(minLength: 2)
            miniButton("chevron.up") { editor.bringForward(id: a.id) }
            miniButton("chevron.down") { editor.sendBackward(id: a.id) }
            miniButton("trash") { editor.remove(id: a.id) }
        }
        .padding(.horizontal, 7).frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 5)
            .fill(selected ? Color.white.opacity(0.16) : .clear))
        .contentShape(Rectangle())
        .onTapGesture { editor.selectedID = a.id; editor.tool = .select }
    }

    private func miniButton(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon).font(.system(size: 9.5))
                .foregroundStyle(.white.opacity(0.55)).frame(width: 18, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var panelOffset: CGSize {
        let w: CGFloat = 184, h: CGFloat = 300
        var x = selection.minX - w - 8            // prefer the selection's left edge
        if x < 8 { x = selection.minX + 8 }       // no room left → nudge inside top-left
        x = min(max(8, x), session.canvasSize.width - w - 8)
        let y = min(max(8, selection.minY), session.canvasSize.height - h - 8)
        return CGSize(width: x, height: y)
    }
}

/// The shared dark rounded chrome behind every overlay bar.
private struct OverlayBarBackground: ViewModifier {
    func body(content: Content) -> some View {
        content.background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.black.opacity(0.86))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(.white.opacity(0.12)))
                .shadow(color: .black.opacity(0.4), radius: 14, y: 6)
        )
    }
}

private extension View {
    func overlayBarChrome() -> some View { modifier(OverlayBarBackground()) }
}

/// An inline hue spectrum — drag anywhere along it to pick a vivid custom colour
/// (kept in-panel; a native ColorPicker's NSColorPanel would open behind the
/// screen-cover overlay and be unreachable).
private struct HueBar: View {
    @ObservedObject var editor: AnnotationEditorState

    private static let stops: [Color] = stride(from: 0.0, through: 1.0, by: 0.05)
        .map { Color(hue: $0, saturation: 0.82, brightness: 0.96) }

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(LinearGradient(colors: Self.stops, startPoint: .leading, endPoint: .trailing))
                .overlay(Capsule().strokeBorder(.white.opacity(0.3)))
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0).onChanged { v in
                        let f = min(max(0, v.location.x / max(geo.size.width, 1)), 1)
                        let picked = Color(hue: f, saturation: 0.82, brightness: 0.96)
                        if let hex = picked.hexString { editor.applyCustom(hex: hex) }
                    }
                )
        }
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
                            .frame(width: 26, height: 26)
                            .contentShape(Rectangle())
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
                            .frame(width: 26, height: 26)
                            .contentShape(Rectangle())
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
        ai.send(crop: crop, cropPointSize: sel.size, editor: session.editor,
                axNodes: session.axAnchorsForAI())
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
