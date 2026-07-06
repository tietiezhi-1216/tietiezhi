//  AnnotationCanvas.swift
//  Draws + edits the annotation objects over the selected region. One shared
//  renderer paints annotations into a SwiftUI GraphicsContext, so the live
//  canvas and the exported bitmap (ImageRenderer over `AnnotatedImageView`)
//  are guaranteed to look identical.

import SwiftUI

// MARK: - Shared renderer

enum AnnotationRenderer {

    /// Paint one annotation. `pixelated` is the pre-blocked copy of the crop
    /// (mosaic clips into it); `canvasSize` is the crop size in points.
    static func draw(_ a: Annotation, in ctx: inout GraphicsContext,
                     canvasSize: CGSize, pixelated: Image?) {
        let color = a.color.color
        switch a.kind {
        case .arrow:
            let head = max(10, a.lineWidth * 3.4)
            let angle = atan2(a.end.y - a.start.y, a.end.x - a.start.x)
            // Shaft stops where the head begins so the tip stays crisp.
            let shaftEnd = CGPoint(x: a.end.x - cos(angle) * head * 0.72,
                                   y: a.end.y - sin(angle) * head * 0.72)
            var shaft = Path()
            shaft.move(to: a.start)
            shaft.addLine(to: shaftEnd)
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.35), radius: 1.5))
            layer.stroke(shaft, with: .color(color),
                         style: StrokeStyle(lineWidth: a.lineWidth, lineCap: .round))
            layer.fill(arrowHead(tip: a.end, angle: angle, length: head), with: .color(color))

        case .line:
            var path = Path()
            path.move(to: a.start)
            path.addLine(to: a.end)
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.3), radius: 1.2))
            layer.stroke(path, with: .color(color),
                         style: StrokeStyle(lineWidth: a.lineWidth, lineCap: .round))

        case .rect:
            let path = Path(roundedRect: a.rect, cornerRadius: 2)
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.3), radius: 1.2))
            layer.stroke(path, with: .color(color),
                         style: StrokeStyle(lineWidth: a.lineWidth, lineJoin: .round))

        case .ellipse:
            let path = Path(ellipseIn: a.rect)
            var layer = ctx
            layer.addFilter(.shadow(color: .black.opacity(0.3), radius: 1.2))
            layer.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: a.lineWidth))

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
            layer.addFilter(.shadow(color: .black.opacity(a.color == .white ? 0.75 : 0.28),
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
                .foregroundColor(a.color == .white || a.color == .yellow ? .black : .white)
            let resolved = ctx.resolve(label)
            let size = resolved.measure(in: CGSize(width: 100, height: 100))
            ctx.draw(resolved, at: a.start, anchor: .center)
            _ = size
        }
    }

    static func arrowHead(tip: CGPoint, angle: CGFloat, length: CGFloat) -> Path {
        let spread: CGFloat = .pi / 7
        var path = Path()
        path.move(to: tip)
        path.addLine(to: CGPoint(x: tip.x - cos(angle - spread) * length,
                                 y: tip.y - sin(angle - spread) * length))
        path.addLine(to: CGPoint(x: tip.x - cos(angle + spread) * length,
                                 y: tip.y - sin(angle + spread) * length))
        path.closeSubpath()
        return path
    }
}

// MARK: - Interactive canvas

/// The editing surface laid exactly over the selection. Draws every annotation
/// plus the in-progress draft and selection chrome; handles create / select /
/// move / endpoint-drag gestures and in-place text editing.
struct AnnotationCanvasView: View {
    @ObservedObject var editor: AnnotationEditorState
    let size: CGSize
    /// Pre-pixelated copy of the crop (for mosaic), same point size as `size`.
    let pixelated: CGImage?
    let displayScale: CGFloat

    @State private var draft: Annotation?
    @State private var dragMode: DragMode = .none
    @State private var dragStartPoint: CGPoint = .zero
    @State private var lastClick: (date: Date, id: UUID?) = (.distantPast, nil)
    @FocusState private var textFieldFocused: Bool

    private enum DragMode {
        case none
        case creating
        case moving(id: UUID, last: CGPoint)
        case handle(id: UUID, which: HandleKind)
    }

    private enum HandleKind { case start, end, corner(Int) } // corners: 0 TL 1 TR 2 BL 3 BR

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

            if let id = editor.editingTextID {
                textEditorOverlay(id: id)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipped()
    }

    // MARK: Selection chrome

    private func drawSelectionChrome(_ a: Annotation, in ctx: inout GraphicsContext) {
        let accent = Color(nsColor: .controlAccentColor)
        let dash = StrokeStyle(lineWidth: 1, dash: [4, 3])
        switch a.kind {
        case .arrow, .line:
            for p in [a.start, a.end] { drawHandle(at: p, in: &ctx, accent: accent) }
        case .rect, .ellipse, .highlight, .mosaic:
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
                let p = clamp(value.location)
                switch dragMode {
                case .none:
                    beginDrag(at: clamp(value.startLocation))
                    fallthrough
                case .creating, .moving, .handle:
                    continueDrag(to: p)
                }
            }
            .onEnded { value in
                endDrag(at: clamp(value.location), start: clamp(value.startLocation))
            }
    }

    private func clamp(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(0, p.x), size.width), y: min(max(0, p.y), size.height))
    }

    private func beginDrag(at p: CGPoint) {
        dragStartPoint = p
        // Commit any in-place text edit before starting something new.
        if editor.editingTextID != nil { commitTextEditing() }

        // 1. A handle of the current selection always wins.
        if let sel = editor.selected, let handle = handleHit(sel, at: p) {
            editor.snapshot()
            dragMode = .handle(id: sel.id, which: handle)
            return
        }
        // 2. Drawing tools create; the select tool (nil) moves / selects.
        if let tool = editor.tool {
            switch tool {
            case .text, .badge:
                dragMode = .creating   // resolved on end (tap-to-place)
                draft = nil
            default:
                var a = Annotation(kind: tool, start: p, end: p,
                                   color: editor.color, lineWidth: editor.lineWidth,
                                   fontSize: editor.fontSize)
                if tool == .freehand { a.points = [p] }
                draft = a
                dragMode = .creating
            }
        } else {
            if let hit = editor.hitTest(p) {
                editor.selectedID = hit.id
                editor.snapshot()
                dragMode = .moving(id: hit.id, last: p)
            } else {
                editor.selectedID = nil
                dragMode = .creating   // empty-space drag in select mode: no-op
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
        case .moving(let id, let last):
            let delta = CGSize(width: p.x - last.x, height: p.y - last.y)
            editor.update(id: id) { $0.translate(by: delta) }
            dragMode = .moving(id: id, last: p)
        case .handle(let id, let which):
            editor.update(id: id) { a in
                switch which {
                case .start: a.start = p
                case .end:   a.end = p
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
            if let tool = editor.tool, !moved {
                // Tap-to-place tools.
                if tool == .text {
                    editor.snapshot()
                    let a = Annotation(kind: .text, start: p, end: p, text: "",
                                       color: editor.color, lineWidth: editor.lineWidth,
                                       fontSize: editor.fontSize)
                    editor.add(a)
                    editor.selectedID = a.id
                    editor.editingTextID = a.id
                    return
                }
                if tool == .badge {
                    editor.snapshot()
                    let a = Annotation(kind: .badge, start: p, end: p,
                                       number: editor.nextBadgeNumber,
                                       color: editor.color, lineWidth: editor.lineWidth,
                                       fontSize: editor.fontSize)
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
        case .moving(let id, _):
            if !moved {
                // A click, not a move — check for double-click text editing.
                if let a = editor.annotations.first(where: { $0.id == id }) {
                    registerClickForDoubleTap(a)
                }
            }
        case .handle, .none:
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
        case .rect, .ellipse, .highlight, .mosaic:
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
            .foregroundStyle(a.color.color)
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

@MainActor
enum AnnotationExporter {
    /// Compose crop + annotations into a bitmap at the display's scale.
    static func render(crop: CGImage, annotations: [Annotation],
                       pointSize: CGSize, pixelated: CGImage?, scale: CGFloat) -> NSImage? {
        let view = AnnotatedImageView(crop: crop, annotations: annotations,
                                      size: pointSize, pixelated: pixelated, displayScale: scale)
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        renderer.isOpaque = true
        return renderer.nsImage
    }
}
