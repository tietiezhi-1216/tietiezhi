//  AnnotationCanvas.swift
//  Draws + edits the annotation objects over the selected region. One shared
//  renderer paints annotations into a SwiftUI GraphicsContext, so the live
//  canvas and the exported bitmap (ImageRenderer over `AnnotatedImageView`)
//  are guaranteed to look identical.

import SwiftUI

// MARK: - Shared renderer

enum AnnotationRenderer {

    /// Stroke style for the outlined shapes — carries the line width and the
    /// dash pattern. Round caps make dotted strokes render as dots.
    static func strokeStyle(_ a: Annotation) -> StrokeStyle {
        StrokeStyle(lineWidth: a.lineWidth, lineCap: .round, lineJoin: .round,
                    dash: a.dash.pattern(for: a.lineWidth) ?? [])
    }

    /// Paint one annotation. `pixelated` is the pre-blocked copy of the crop
    /// (mosaic clips into it); `canvasSize` is the crop size in points.
    static func draw(_ a: Annotation, in ctx: inout GraphicsContext,
                     canvasSize: CGSize, pixelated: Image?) {
        let color = a.displayColor
        switch a.kind {
        case .arrow:
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.35), radius: 1.5, y: 0.5))
            switch a.arrowType {
            case .filled:
                // A single filled shape: a shaft tapering from a fine tail to a
                // crisp head, following the (optionally curved) path.
                let shape = arrowShape(start: a.start, control: a.arrowControl, end: a.end,
                                       lineWidth: a.lineWidth, headScale: a.arrowHeadScale)
                layer.fill(shape, with: .color(color))
            case .line:
                // A constant-width line to the head base, plus a filled triangle head.
                let (shaft, head) = lineArrow(start: a.start, control: a.arrowControl, end: a.end,
                                              lineWidth: a.lineWidth, headScale: a.arrowHeadScale)
                layer.stroke(shaft, with: .color(color),
                             style: StrokeStyle(lineWidth: a.lineWidth, lineCap: .round, lineJoin: .round))
                layer.fill(head, with: .color(color))
            }

        case .line:
            var path = Path()
            path.move(to: a.start)
            path.addLine(to: a.end)
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.3), radius: 1.2))
            layer.stroke(path, with: .color(color), style: strokeStyle(a))

        case .rect:
            let path = Path(roundedRect: a.rect, cornerRadius: max(0, a.cornerRadius))
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.3), radius: 1.2))
            if a.filled { layer.fill(path, with: .color(color.opacity(0.85))) }
            layer.stroke(path, with: .color(color), style: strokeStyle(a))

        case .ellipse:
            let path = Path(ellipseIn: a.rect)
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.3), radius: 1.2))
            if a.filled { layer.fill(path, with: .color(color.opacity(0.85))) }
            layer.stroke(path, with: .color(color), style: strokeStyle(a))

        case .spotlight:
            // Reverse highlight: dim the whole crop, punch a hole over the region
            // (even-odd), then ring the focus edge in the annotation's colour.
            let r = max(0, a.cornerRadius)
            ctx.drawLayer { layer in
                var path = Path(CGRect(origin: .zero, size: canvasSize))
                path.addPath(Path(roundedRect: a.rect, cornerRadius: r))
                layer.fill(path, with: .color(.black.opacity(0.5)), style: FillStyle(eoFill: true))
            }
            ctx.stroke(Path(roundedRect: a.rect, cornerRadius: r),
                       with: .color(color.opacity(0.9)), lineWidth: max(1, a.lineWidth * 0.5))

        case .freehand:
            guard let pts = a.points, pts.count > 1 else { return }
            var path = Path()
            path.move(to: pts[0])
            for p in pts.dropFirst() { path.addLine(to: p) }
            ctx.stroke(path, with: .color(color),
                       style: StrokeStyle(lineWidth: a.lineWidth, lineCap: .round, lineJoin: .round))

        case .text:
            guard let string = a.text, !string.isEmpty else { return }
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(a.isLightColor ? 0.75 : 0.28),
                                    radius: 1.6, y: 1))
            let text = Text(string)
                .font(.system(size: a.fontSize, weight: .semibold))
                .foregroundColor(color)
            layer.draw(layer.resolve(text), in: CGRect(origin: a.start, size: a.textBounds()))

        case .highlight:
            // Marker feel: multiply so the ink darkens what's underneath.
            ctx.drawLayer { layer in
                layer.blendMode = .multiply
                layer.fill(Path(a.rect), with: .color(color.opacity(0.42)))
            }

        case .mosaic:
            guard let pixelated else { return }
            ctx.drawLayer { layer in
                layer.clip(to: Path(a.rect))
                layer.draw(pixelated, in: CGRect(origin: .zero, size: canvasSize))
            }

        case .badge:
            let r = a.badgeRadius
            let circle = Path(ellipseIn: CGRect(x: a.start.x - r, y: a.start.y - r,
                                                width: r * 2, height: r * 2))
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.35), radius: 2, y: 1))
            layer.fill(circle, with: .color(color))
            layer.stroke(circle, with: .color(.white.opacity(0.9)), lineWidth: 1.5)
            let label = Text("\(a.number ?? 1)")
                .font(.system(size: r * 1.1, weight: .bold, design: .rounded))
                .foregroundColor(a.isLightColor ? .black : .white)
            let resolved = ctx.resolve(label)
            let size = resolved.measure(in: CGSize(width: 100, height: 100))
            ctx.draw(resolved, at: a.start, anchor: .center)
            _ = size
        }
    }

    /// A tapered arrow as one closed, fillable shape. The shaft narrows to a fine
    /// point at the tail (`尾巴尖尖`) and swells toward a triangular head; the whole
    /// thing rides a quadratic Bézier so straight and curved arrows share a path.
    static func arrowShape(start: CGPoint, control: CGPoint, end: CGPoint,
                           lineWidth: CGFloat, headScale: CGFloat = 1) -> Path {
        let steps = 40
        let pts = QuadCurve.sample(start, control, end, steps: steps)

        // Cumulative arc length along the sampled curve.
        var arc = [CGFloat](repeating: 0, count: pts.count)
        for i in 1...steps { arc[i] = arc[i - 1] + pts[i].distance(to: pts[i - 1]) }
        let total = arc[steps]
        guard total > 0.5 else { return Path() }

        // Head eats the last stretch of the curve; shaft fills the rest.
        let headLen = min(max(13, lineWidth * 3.4) * headScale, total * 0.72)
        let fullWidth = max(lineWidth * 1.5, 3)          // shaft thickness at the base
        let headHalf = max(headLen * 0.46, fullWidth * 1.55)

        // Index where the head begins (remaining length ≈ headLen).
        var baseIdx = steps
        for i in 0...steps where total - arc[i] <= headLen { baseIdx = i; break }
        baseIdx = max(1, min(baseIdx, steps - 1))

        func tangent(_ i: Int) -> CGPoint {
            let a = pts[max(0, i - 1)], b = pts[min(steps, i + 1)]
            let d = CGPoint(x: b.x - a.x, y: b.y - a.y)
            let len = max(hypot(d.x, d.y), 0.0001)
            return CGPoint(x: d.x / len, y: d.y / len)
        }
        func normal(_ i: Int) -> CGPoint { let t = tangent(i); return CGPoint(x: -t.y, y: t.x) }
        // Half-width: 0 at the tail, easing up to the base thickness.
        func halfWidth(_ i: Int) -> CGFloat {
            let shaftLen = max(total - headLen, 0.001)
            let f = min(1, arc[i] / shaftLen)
            return fullWidth * 0.5 * pow(f, 0.6)
        }

        var left: [CGPoint] = [], right: [CGPoint] = []
        for i in 0...baseIdx {
            let n = normal(i), hw = halfWidth(i)
            left.append(CGPoint(x: pts[i].x + n.x * hw, y: pts[i].y + n.y * hw))
            right.append(CGPoint(x: pts[i].x - n.x * hw, y: pts[i].y - n.y * hw))
        }

        let bn = normal(baseIdx), base = pts[baseIdx]
        let headL = CGPoint(x: base.x + bn.x * headHalf, y: base.y + bn.y * headHalf)
        let headR = CGPoint(x: base.x - bn.x * headHalf, y: base.y - bn.y * headHalf)

        var path = Path()
        path.move(to: left[0])                       // tail point
        for p in left.dropFirst() { path.addLine(to: p) }
        path.addLine(to: headL)                      // flare out to the head base
        path.addLine(to: end)                        // tip
        path.addLine(to: headR)
        for p in right.reversed() { path.addLine(to: p) }
        path.closeSubpath()
        return path
    }

    /// The `.line` arrow: a constant-width shaft (stroked separately) up to the
    /// head base, and a filled triangular head at the tip. Shares the Bézier path.
    static func lineArrow(start: CGPoint, control: CGPoint, end: CGPoint,
                          lineWidth: CGFloat, headScale: CGFloat) -> (shaft: Path, head: Path) {
        let steps = 40
        let pts = QuadCurve.sample(start, control, end, steps: steps)
        var arc = [CGFloat](repeating: 0, count: pts.count)
        for i in 1...steps { arc[i] = arc[i - 1] + pts[i].distance(to: pts[i - 1]) }
        let total = arc[steps]
        guard total > 0.5 else { return (Path(), Path()) }

        let headLen = min(max(14, lineWidth * 3.8) * headScale, total * 0.85)
        let headHalf = headLen * 0.55

        var baseIdx = steps
        for i in 0...steps where total - arc[i] <= headLen { baseIdx = i; break }
        baseIdx = max(1, min(baseIdx, steps - 1))

        var shaft = Path()
        shaft.move(to: pts[0])
        for i in 1...baseIdx { shaft.addLine(to: pts[i]) }

        let a = pts[max(0, baseIdx - 1)], b = pts[min(steps, baseIdx + 1)]
        let d = CGPoint(x: b.x - a.x, y: b.y - a.y)
        let len = max(hypot(d.x, d.y), 0.0001)
        let n = CGPoint(x: -d.y / len, y: d.x / len)
        let base = pts[baseIdx]
        var head = Path()
        head.move(to: end)                                                   // tip
        head.addLine(to: CGPoint(x: base.x + n.x * headHalf, y: base.y + n.y * headHalf))
        head.addLine(to: CGPoint(x: base.x - n.x * headHalf, y: base.y - n.y * headHalf))
        head.closeSubpath()
        return (shaft, head)
    }
}

// MARK: - Interactive canvas

/// Phases of an interior drag that moves the whole selection region (only when the
/// select tool is active and the drag starts on empty space, not an annotation).
enum SelectionMovePhase { case began; case changed(CGSize); case ended }

/// The editing surface laid exactly over the selection. Draws every annotation
/// plus the in-progress draft and selection chrome; handles create / select /
/// move / endpoint-drag gestures and in-place text editing.
struct AnnotationCanvasView: View {
    @ObservedObject var editor: AnnotationEditorState
    let size: CGSize
    /// Pre-pixelated copy of the crop (for mosaic), same point size as `size`.
    let pixelated: CGImage?
    let displayScale: CGFloat
    /// Drag empty space in select mode → move the whole selection (nil disables it).
    var onSelectionMove: ((SelectionMovePhase) -> Void)? = nil

    @State private var draft: Annotation?
    @State private var dragMode: DragMode = .none
    @State private var dragStartPoint: CGPoint = .zero
    @State private var lastClick: (date: Date, id: UUID?) = (.distantPast, nil)
    @State private var hoverInterior = false
    /// Absolute mouse position (screen coords) at the start of a selection move —
    /// the delta comes from here, NOT the gesture translation, which feeds back
    /// once the selection (and this view) starts moving under the cursor.
    @State private var moveStartMouse: NSPoint = .zero
    @FocusState private var textFieldFocused: Bool

    private enum DragMode {
        case none
        case creating
        case erasing
        case movingSelection
        case moving(id: UUID, last: CGPoint)
        case handle(id: UUID, which: HandleKind)
    }

    private enum HandleKind { case start, end, control, corner(Int) } // corners: 0 TL 1 TR 2 BL 3 BR

    private var pixelatedImage: Image? {
        pixelated.map { Image(decorative: $0, scale: displayScale) }
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Canvas { ctx, _ in
                for a in editor.annotations where a.id != editor.editingTextID {
                    AnnotationRenderer.draw(a, in: &ctx, canvasSize: size, pixelated: pixelatedImage)
                }
                if let draft {
                    AnnotationRenderer.draw(draft, in: &ctx, canvasSize: size, pixelated: pixelatedImage)
                }
                if let sel = editor.selected {
                    drawSelectionChrome(sel, in: &ctx)
                }
            }
            .contentShape(Rectangle())
            .gesture(canvasGesture)
            .onContinuousHover { phase in updateCursor(phase) }

            if let id = editor.editingTextID {
                textEditorOverlay(id: id)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    /// In select mode, empty interior reads as "grab to move" (open hand); over an
    /// annotation it's the pointer. Drawing tools keep the crosshair pushed by the
    /// overlay. Only meaningful when interior-move is wired up.
    private func updateCursor(_ phase: HoverPhase) {
        guard onSelectionMove != nil, case .select = editor.tool else {
            if case .ended = phase, hoverInterior { hoverInterior = false }
            return
        }
        switch phase {
        case .active(let p):
            let overAnnotation = editor.hitTest(p) != nil
            if overAnnotation { NSCursor.arrow.set() } else { NSCursor.openHand.set() }
            hoverInterior = true
        case .ended:
            if hoverInterior { NSCursor.crosshair.set(); hoverInterior = false }
        }
    }

    // MARK: Selection chrome

    private func drawSelectionChrome(_ a: Annotation, in ctx: inout GraphicsContext) {
        let accent = Color(nsColor: .controlAccentColor)
        let dash = StrokeStyle(lineWidth: 1, dash: [4, 3])
        switch a.kind {
        case .arrow, .line:
            for p in [a.start, a.end] { drawHandle(at: p, in: &ctx, accent: accent) }
            if a.kind == .arrow { drawControlHandle(at: a.arrowControl, in: &ctx, accent: accent) }
        case .rect, .ellipse, .highlight, .mosaic, .spotlight:
            ctx.stroke(Path(a.rect.insetBy(dx: -3, dy: -3)), with: .color(accent), style: dash)
            for p in cornerPoints(a.rect) { drawHandle(at: p, in: &ctx, accent: accent) }
        case .text:
            let box = CGRect(origin: a.start, size: a.textBounds()).insetBy(dx: -4, dy: -3)
            ctx.stroke(Path(box), with: .color(accent), style: dash)
        case .badge:
            let r = a.badgeRadius + 3
            ctx.stroke(Path(ellipseIn: CGRect(x: a.start.x - r, y: a.start.y - r,
                                              width: r * 2, height: r * 2)),
                       with: .color(accent), style: dash)
        case .freehand:
            if let pts = a.points, let box = boundingBox(pts) {
                ctx.stroke(Path(box.insetBy(dx: -4, dy: -4)), with: .color(accent), style: dash)
            }
        }
    }

    private func drawHandle(at p: CGPoint, in ctx: inout GraphicsContext, accent: Color) {
        let rect = CGRect(x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9)
        ctx.fill(Path(ellipseIn: rect), with: .color(.white))
        ctx.stroke(Path(ellipseIn: rect), with: .color(accent), lineWidth: 1.5)
    }

    /// The bend handle for a curved arrow — a smaller accent-filled dot so it
    /// reads as "drag me to curve" and not as an endpoint.
    private func drawControlHandle(at p: CGPoint, in ctx: inout GraphicsContext, accent: Color) {
        let rect = CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)
        ctx.fill(Path(ellipseIn: rect), with: .color(accent))
        ctx.stroke(Path(ellipseIn: rect), with: .color(.white), lineWidth: 1.5)
    }

    private func cornerPoints(_ r: CGRect) -> [CGPoint] {
        [CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY),
         CGPoint(x: r.minX, y: r.maxY), CGPoint(x: r.maxX, y: r.maxY)]
    }

    private func boundingBox(_ pts: [CGPoint]) -> CGRect? {
        guard let first = pts.first else { return nil }
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for p in pts {
            minX = min(minX, p.x); maxX = max(maxX, p.x)
            minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    // MARK: Gesture

    private var canvasGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if case .none = dragMode { beginDrag(at: clamp(value.startLocation)) }
                switch dragMode {
                case .movingSelection:
                    // Delta from the ABSOLUTE mouse position (screen coords), which
                    // is immune to the selection/view moving under the cursor as we
                    // reframe. y is flipped: Cocoa is bottom-up, view is top-down.
                    NSCursor.closedHand.set()
                    let m = NSEvent.mouseLocation
                    let delta = CGSize(width: m.x - moveStartMouse.x, height: moveStartMouse.y - m.y)
                    onSelectionMove?(.changed(delta))
                case .creating, .erasing, .moving, .handle:
                    continueDrag(to: clamp(value.location))
                case .none:
                    break
                }
            }
            .onEnded { value in
                if case .movingSelection = dragMode {
                    onSelectionMove?(.ended)
                    NSCursor.openHand.set()
                    dragMode = .none
                } else {
                    endDrag(at: clamp(value.location), start: clamp(value.startLocation))
                }
            }
    }

    private func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(0, p.x), size.width), y: min(max(0, p.y), size.height))
    }

    private func beginDrag(at p: CGPoint) {
        dragStartPoint = p
        // Commit any in-place text edit before starting something new.
        if editor.editingTextID != nil { commitTextEditing() }

        // 1. A handle of the current selection always wins (except in erase mode).
        if case .erase = editor.tool {} else if let sel = editor.selected,
           let handle = handleHit(sel, at: p) {
            editor.snapshot()
            dragMode = .handle(id: sel.id, which: handle)
            return
        }
        // 2. Draw tools create; erase removes on touch; select moves / selects.
        switch editor.tool {
        case .erase:
            editor.snapshot()          // one undo covers the whole erase drag
            editor.eraseAt(p)
            dragMode = .erasing
        case .draw(.text), .draw(.badge):
            dragMode = .creating       // resolved on end (tap-to-place)
            draft = nil
        case .draw(let kind):
            var a = Annotation(kind: kind, start: p, end: p,
                               color: editor.color, colorHex: editor.colorHex,
                               lineWidth: editor.lineWidth, fontSize: editor.fontSize,
                               filled: editor.filled, dash: editor.dash,
                               cornerRadius: editor.cornerRadius,
                               arrowType: editor.arrowType, arrowHeadScale: editor.arrowHeadScale)
            if kind == .freehand { a.points = [p] }
            draft = a
            dragMode = .creating
        case .select:
            if let hit = editor.hitTest(p) {
                editor.selectedID = hit.id
                editor.snapshot()
                dragMode = .moving(id: hit.id, last: p)
            } else if onSelectionMove != nil {
                // Empty interior in select mode → drag the whole selection region.
                editor.selectedID = nil
                moveStartMouse = NSEvent.mouseLocation
                onSelectionMove?(.began)
                dragMode = .movingSelection
            } else {
                editor.selectedID = nil
                dragMode = .creating
                draft = nil
            }
        }
    }

    private func continueDrag(to p: CGPoint) {
        switch dragMode {
        case .creating:
            guard var a = draft else { return }
            if a.kind == .freehand {
                a.points?.append(p)
            }
            a.end = p
            draft = a
        case .erasing:
            editor.eraseAt(p)
        case .movingSelection:
            break   // driven by the gesture's translation, not local points
        case .moving(let id, let last):
            let delta = CGSize(width: p.x - last.x, height: p.y - last.y)
            editor.update(id: id) { $0.translate(by: delta) }
            dragMode = .moving(id: id, last: p)
        case .handle(let id, let which):
            editor.update(id: id) { a in
                switch which {
                case .start: a.start = p
                case .end:   a.end = p
                case .control: a.control = p
                case .corner(let i):
                    // Move the dragged corner; the opposite corner stays pinned.
                    var r = a.rect
                    let opposite: CGPoint
                    switch i {
                    case 0: opposite = CGPoint(x: r.maxX, y: r.maxY)
                    case 1: opposite = CGPoint(x: r.minX, y: r.maxY)
                    case 2: opposite = CGPoint(x: r.maxX, y: r.minY)
                    default: opposite = CGPoint(x: r.minX, y: r.minY)
                    }
                    r = CGRect(x: min(p.x, opposite.x), y: min(p.y, opposite.y),
                               width: abs(p.x - opposite.x), height: abs(p.y - opposite.y))
                    a.start = r.origin
                    a.end = CGPoint(x: r.maxX, y: r.maxY)
                }
            }
        case .none:
            break
        }
    }

    private func endDrag(at p: CGPoint, start: CGPoint) {
        defer { dragMode = .none; draft = nil }
        let moved = p.distance(to: start) > 3

        switch dragMode {
        case .creating:
            if case .draw(let kind) = editor.tool, !moved {
                // Tap-to-place tools.
                if kind == .text {
                    editor.snapshot()
                    let a = Annotation(kind: .text, start: p, end: p, text: "",
                                       color: editor.color, colorHex: editor.colorHex,
                                       lineWidth: editor.lineWidth, fontSize: editor.fontSize)
                    editor.add(a)
                    editor.selectedID = a.id
                    editor.editingTextID = a.id
                    return
                }
                if kind == .badge {
                    editor.snapshot()
                    let a = Annotation(kind: .badge, start: p, end: p,
                                       number: editor.nextBadgeNumber,
                                       color: editor.color, colorHex: editor.colorHex,
                                       lineWidth: editor.lineWidth, fontSize: editor.fontSize)
                    editor.add(a)
                    editor.selectedID = a.id
                    return
                }
                // A plain click with a drawing tool: select whatever is under it
                // (lets users adjust without switching to the select tool).
                if let hit = editor.hitTest(p) {
                    registerClickForDoubleTap(hit)
                    editor.selectedID = hit.id
                } else {
                    editor.selectedID = nil
                }
                return
            }
            if let a = draft, moved {
                editor.snapshot()
                editor.add(a)
                editor.selectedID = a.id
            }
        case .erasing:
            break
        case .moving(let id, _):
            if !moved {
                // A click, not a move — check for double-click text editing.
                if let a = editor.annotations.first(where: { $0.id == id }) {
                    registerClickForDoubleTap(a)
                }
            }
        case .handle, .movingSelection, .none:
            break
        }
    }

    /// Double-click a text annotation to re-open in-place editing.
    private func registerClickForDoubleTap(_ a: Annotation) {
        let now = Date()
        if a.kind == .text, lastClick.id == a.id,
           now.timeIntervalSince(lastClick.date) < 0.4 {
            editor.editingTextID = a.id
        }
        lastClick = (now, a.id)
    }

    private func handleHit(_ a: Annotation, at p: CGPoint) -> HandleKind? {
        let r: CGFloat = 9
        switch a.kind {
        case .arrow, .line:
            if p.distance(to: a.start) < r { return .start }
            if p.distance(to: a.end) < r { return .end }
            if a.kind == .arrow, p.distance(to: a.arrowControl) < r { return .control }
        case .rect, .ellipse, .highlight, .mosaic, .spotlight:
            for (i, c) in cornerPoints(a.rect).enumerated() where p.distance(to: c) < r {
                return .corner(i)
            }
        default:
            break
        }
        return nil
    }

    // MARK: In-place text editing

    @ViewBuilder
    private func textEditorOverlay(id: UUID) -> some View {
        if let a = editor.annotations.first(where: { $0.id == id }) {
            TextField("输入文字…", text: Binding(
                get: { editor.annotations.first(where: { $0.id == id })?.text ?? "" },
                set: { newValue in editor.update(id: id) { $0.text = newValue } }
            ), axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: a.fontSize, weight: .semibold))
            .foregroundStyle(a.displayColor)
            .padding(2)
            .frame(minWidth: 60, maxWidth: 320, alignment: .leading)
            .fixedSize(horizontal: true, vertical: true)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(Color(nsColor: .controlAccentColor), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                    .background(Color.black.opacity(0.12))
            )
            .focused($textFieldFocused)
            .onSubmit { commitTextEditing() }
            .onAppear { textFieldFocused = true }
            .offset(x: a.start.x - 2, y: a.start.y - 2)
        }
    }

    func commitTextEditing() {
        guard let id = editor.editingTextID else { return }
        editor.editingTextID = nil
        // An empty text box is noise — drop it.
        if let a = editor.annotations.first(where: { $0.id == id }),
           a.text?.trimmed.isEmpty != false {
            editor.annotations.removeAll { $0.id == id }
            if editor.selectedID == id { editor.selectedID = nil }
        }
    }
}

// MARK: - Export composition

/// The final bitmap: crop + annotations, rendered by ImageRenderer at the
/// screen's scale. Identical drawing path as the live canvas.
struct AnnotatedImageView: View {
    let crop: CGImage
    let annotations: [Annotation]
    let size: CGSize
    let pixelated: CGImage?
    let displayScale: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Image(decorative: crop, scale: displayScale)
                .resizable()
                .frame(width: size.width, height: size.height)
            Canvas { ctx, _ in
                let pixelatedImage = pixelated.map { Image(decorative: $0, scale: displayScale) }
                for a in annotations {
                    AnnotationRenderer.draw(a, in: &ctx, canvasSize: size, pixelated: pixelatedImage)
                }
            }
            .frame(width: size.width, height: size.height)
        }
        .frame(width: size.width, height: size.height)
    }
}

/// The annotated shot wrapped in an optional beautify frame (padding + rounded
/// corners + shadow + backdrop). Same view for the live preview and the export,
/// so what you see is what gets saved.
struct ExportComposition: View {
    let crop: CGImage
    let annotations: [Annotation]
    let size: CGSize
    let pixelated: CGImage?
    let displayScale: CGFloat
    let beautify: BeautifyParams?

    var body: some View {
        let core = AnnotatedImageView(crop: crop, annotations: annotations, size: size,
                                      pixelated: pixelated, displayScale: displayScale)
        if let b = beautify {
            ZStack {
                RoundedRectangle(cornerRadius: b.corner + b.padding * 0.4, style: .continuous)
                    .fill(b.background.fill)
                core
                    .clipShape(RoundedRectangle(cornerRadius: b.corner, style: .continuous))
                    .shadow(color: .black.opacity(0.28), radius: b.padding * 0.42, y: b.padding * 0.2)
            }
            .frame(width: size.width + b.padding * 2, height: size.height + b.padding * 2)
        } else {
            core
        }
    }
}

@MainActor
enum AnnotationExporter {
    /// Compose crop + annotations (+ optional beautify frame) into a bitmap at the
    /// display's scale.
    static func render(crop: CGImage, annotations: [Annotation],
                       pointSize: CGSize, pixelated: CGImage?, scale: CGFloat,
                       beautify: BeautifyParams? = nil) -> NSImage? {
        let view = ExportComposition(crop: crop, annotations: annotations, size: pointSize,
                                     pixelated: pixelated, displayScale: scale, beautify: beautify)
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        renderer.isOpaque = !(beautify?.background.isTransparent ?? false)
        return renderer.nsImage
    }
}
