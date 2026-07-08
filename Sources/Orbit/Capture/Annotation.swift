//  Annotation.swift
//  Vector annotation objects for the screenshot editor. Everything the user (or
//  the AI) draws is one of these — Codable so history can round-trip them, and
//  geometry stays in IMAGE-POINT coordinates (top-left origin, y down) so the
//  same objects render on the on-screen canvas and in the exported bitmap.

import SwiftUI

// MARK: - Kind / palette

enum AnnotationKind: String, Codable, CaseIterable, Identifiable {
    case arrow      // start → end, filled head at `end`
    case line
    case polyline   // multi-segment path through `points` (click to add vertices)
    case rect
    case ellipse
    case freehand   // `points`
    case text       // `text` anchored at `start`
    case highlight  // translucent marker block
    case mosaic     // pixelate the region underneath
    case spotlight  // dim everything EXCEPT this region (reverse highlight)
    case magnifier  // a lens magnifying the clean crop under `rect`
    case badge      // numbered circle at `start`
    case watermark  // tiled text stamped across the whole shot

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .arrow:     return "箭头"
        case .line:      return "直线"
        case .polyline:  return "折线"
        case .rect:      return "矩形"
        case .ellipse:   return "椭圆"
        case .freehand:  return "画笔"
        case .text:      return "文字"
        case .highlight: return "高亮"
        case .mosaic:    return "马赛克"
        case .spotlight: return "聚光灯"
        case .magnifier: return "放大镜"
        case .badge:     return "序号"
        case .watermark: return "水印"
        }
    }

    var symbol: String {
        switch self {
        case .arrow:     return "arrow.up.right"
        case .line:      return "line.diagonal"
        case .polyline:  return "scribble.variable"
        case .rect:      return "rectangle"
        case .ellipse:   return "circle"
        case .freehand:  return "pencil.and.scribble"
        case .text:      return "character.cursor.ibeam"
        case .highlight: return "highlighter"
        case .mosaic:    return "mosaic"
        case .spotlight: return "scope"
        case .magnifier: return "plus.magnifyingglass"
        case .badge:     return "1.circle"
        case .watermark: return "signature"
        }
    }
}

/// Stroke dash style for outlined shapes (the 实线 / 虚线 / 点线 property control).
enum LineDashStyle: String, Codable, CaseIterable, Identifiable {
    case solid, dashed, dotted

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .solid:  return "实线"
        case .dashed: return "虚线"
        case .dotted: return "点线"
        }
    }

    /// Dash pattern scaled to the line width; nil = continuous (solid).
    /// Dotted relies on a round line-cap to render the near-zero dash as dots.
    func pattern(for lineWidth: CGFloat) -> [CGFloat]? {
        switch self {
        case .solid:  return nil
        case .dashed: return [max(lineWidth * 2.6, 6), max(lineWidth * 2.0, 5)]
        case .dotted: return [0.01, max(lineWidth * 2.0, 4)]
        }
    }
}

/// Arrow rendering style (the 箭头类型 control).
enum ArrowType: String, Codable, CaseIterable, Identifiable {
    case filled   // tapered solid shaft → crisp head (default)
    case line     // constant-width line + a triangular head

    var id: String { rawValue }
    var displayName: String { self == .filled ? "实心" : "线条" }
    var symbol: String { self == .filled ? "arrowshape.right.fill" : "arrow.right" }
}

/// What a click on the canvas does: pick/move an object, erase one, or draw a
/// specific kind. Replaces the old `AnnotationKind?` tool (nil = select) so the
/// eraser — which isn't a drawable kind — is a first-class mode.
enum CanvasTool: Equatable {
    case select
    case erase
    case draw(AnnotationKind)

    /// The kind this tool draws, or nil for select / erase.
    var drawKind: AnnotationKind? {
        if case .draw(let k) = self { return k }
        return nil
    }
}

/// The fixed 8-colour palette shared by the toolbar and the AI tools (the model
/// names one of these — never a hex string — so results always stay on-brand).
enum AnnotationColor: String, Codable, CaseIterable, Identifiable {
    case red, orange, yellow, green, blue, purple, black, white

    var id: String { rawValue }

    var color: Color {
        switch self {
        case .red:    return Color(red: 0.94, green: 0.23, blue: 0.19)
        case .orange: return Color(red: 0.98, green: 0.58, blue: 0.10)
        case .yellow: return Color(red: 0.99, green: 0.83, blue: 0.15)
        case .green:  return Color(red: 0.22, green: 0.78, blue: 0.35)
        case .blue:   return Color(red: 0.12, green: 0.51, blue: 0.98)
        case .purple: return Color(red: 0.65, green: 0.35, blue: 0.95)
        case .black:  return Color(red: 0.10, green: 0.10, blue: 0.10)
        case .white:  return .white
        }
    }
}

// MARK: - Annotation

struct Annotation: Identifiable, Codable, Hashable {
    var id: UUID
    var kind: AnnotationKind
    /// Anchor / first drag point. For text and badges this is the anchor.
    var start: CGPoint
    /// Second drag point (arrow tip, rect corner, …).
    var end: CGPoint
    /// Freehand stroke path.
    var points: [CGPoint]?
    /// Bézier control point for a CURVED arrow (nil = straight). Absolute image
    /// points, so it moves with the annotation like `start`/`end`.
    var control: CGPoint?
    var text: String?
    /// Badge number (序号).
    var number: Int?
    var color: AnnotationColor
    /// Optional custom colour (`#RRGGBB`). When set it wins over `color`; the
    /// enum still carries a sensible fallback (and is all the AI ever names).
    var colorHex: String?
    var lineWidth: CGFloat
    var fontSize: CGFloat
    /// Fill the interior with the colour (rect / ellipse); outline-only when false.
    var filled: Bool
    /// Stroke dash style for the outlined shapes.
    var dash: LineDashStyle
    /// Corner radius for rect / spotlight (0 = sharp corners).
    var cornerRadius: CGFloat
    /// Arrow rendering style.
    var arrowType: ArrowType
    /// Arrow head size multiplier (箭头粗细) — 1 = default proportion.
    var arrowHeadScale: CGFloat
    /// Font family for text / watermark (nil = system font). Empty string is
    /// normalized to nil so "system" round-trips cleanly.
    var fontFamily: String?
    /// Magnifier lens zoom factor (放大倍率) — how much the crop under `rect` is enlarged.
    var magnification: CGFloat
    /// Magnifier lens shape: round (circle) when true, else the raw rect.
    var lensRound: Bool
    /// Watermark tile opacity (0…1).
    var watermarkOpacity: CGFloat
    /// Watermark tile rotation in degrees.
    var watermarkAngle: CGFloat
    /// Watermark tile spacing (point gap between repeats).
    var watermarkSpacing: CGFloat

    init(id: UUID = UUID(), kind: AnnotationKind,
         start: CGPoint, end: CGPoint,
         points: [CGPoint]? = nil, control: CGPoint? = nil,
         text: String? = nil, number: Int? = nil,
         color: AnnotationColor = .red, colorHex: String? = nil,
         lineWidth: CGFloat = 3, fontSize: CGFloat = 18,
         filled: Bool = false, dash: LineDashStyle = .solid, cornerRadius: CGFloat = 0,
         arrowType: ArrowType = .filled, arrowHeadScale: CGFloat = 1,
         fontFamily: String? = nil, magnification: CGFloat = 2, lensRound: Bool = true,
         watermarkOpacity: CGFloat = 0.18, watermarkAngle: CGFloat = -30,
         watermarkSpacing: CGFloat = 120) {
        self.id = id
        self.kind = kind
        self.start = start
        self.end = end
        self.points = points
        self.control = control
        self.text = text
        self.number = number
        self.color = color
        self.colorHex = colorHex
        self.lineWidth = lineWidth
        self.fontSize = fontSize
        self.filled = filled
        self.dash = dash
        self.cornerRadius = cornerRadius
        self.arrowType = arrowType
        self.arrowHeadScale = arrowHeadScale
        self.fontFamily = fontFamily
        self.magnification = magnification
        self.lensRound = lensRound
        self.watermarkOpacity = watermarkOpacity
        self.watermarkAngle = watermarkAngle
        self.watermarkSpacing = watermarkSpacing
    }

    // Tolerant decode: annotations persist inside screenshot history, and the
    // schema grows — new fields decode with defaults so old entries (and AI
    // JSON that omits them) never fail to load. Same principle as Settings.
    enum CodingKeys: String, CodingKey {
        case id, kind, start, end, points, control, text, number
        case color, colorHex, lineWidth, fontSize
        case filled, dash, cornerRadius, arrowType, arrowHeadScale
        case fontFamily, magnification, lensRound
        case watermarkOpacity, watermarkAngle, watermarkSpacing
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        kind = try c.decode(AnnotationKind.self, forKey: .kind)
        start = try c.decode(CGPoint.self, forKey: .start)
        end = try c.decode(CGPoint.self, forKey: .end)
        points = try c.decodeIfPresent([CGPoint].self, forKey: .points)
        control = try c.decodeIfPresent(CGPoint.self, forKey: .control)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        number = try c.decodeIfPresent(Int.self, forKey: .number)
        color = try c.decodeIfPresent(AnnotationColor.self, forKey: .color) ?? .red
        colorHex = try c.decodeIfPresent(String.self, forKey: .colorHex)
        lineWidth = try c.decodeIfPresent(CGFloat.self, forKey: .lineWidth) ?? 3
        fontSize = try c.decodeIfPresent(CGFloat.self, forKey: .fontSize) ?? 18
        filled = try c.decodeIfPresent(Bool.self, forKey: .filled) ?? false
        dash = try c.decodeIfPresent(LineDashStyle.self, forKey: .dash) ?? .solid
        cornerRadius = try c.decodeIfPresent(CGFloat.self, forKey: .cornerRadius) ?? 0
        arrowType = try c.decodeIfPresent(ArrowType.self, forKey: .arrowType) ?? .filled
        arrowHeadScale = try c.decodeIfPresent(CGFloat.self, forKey: .arrowHeadScale) ?? 1
        fontFamily = try c.decodeIfPresent(String.self, forKey: .fontFamily)
        magnification = try c.decodeIfPresent(CGFloat.self, forKey: .magnification) ?? 2
        lensRound = try c.decodeIfPresent(Bool.self, forKey: .lensRound) ?? true
        watermarkOpacity = try c.decodeIfPresent(CGFloat.self, forKey: .watermarkOpacity) ?? 0.18
        watermarkAngle = try c.decodeIfPresent(CGFloat.self, forKey: .watermarkAngle) ?? -30
        watermarkSpacing = try c.decodeIfPresent(CGFloat.self, forKey: .watermarkSpacing) ?? 120
    }

    /// Effective drawing colour: custom hex wins, else the palette colour.
    var displayColor: Color {
        colorHex.flatMap(Color.init(hex:)) ?? color.color
    }

    /// Is the effective colour light enough that labels/shadows over it need a
    /// dark counterpart? Presets are known; custom colours use luminance.
    var isLightColor: Bool {
        if let rgb = colorHex.flatMap(RGBComponents.init(hex:)) {
            return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) > 0.62
        }
        return color == .white || color == .yellow
    }

    /// The curve's control point (defaults to the straight midpoint).
    var arrowControl: CGPoint {
        control ?? CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
    }

    /// Normalized rect spanned by start/end.
    var rect: CGRect {
        CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
               width: abs(end.x - start.x), height: abs(end.y - start.y))
    }

    var badgeRadius: CGFloat { max(11, fontSize * 0.68) }

    /// A short, human label for the layers panel row.
    var layerTitle: String {
        switch kind {
        case .text:  return (text?.trimmed.isEmpty == false ? text!.trimmed : "文字")
        case .badge: return "序号 \(number ?? 1)"
        default:     return kind.displayName
        }
    }

    /// Generous hit area for selection (the canvas hit-tests back-to-front).
    func hitTest(_ p: CGPoint) -> Bool {
        let slop: CGFloat = 8
        switch kind {
        case .rect, .ellipse, .highlight, .mosaic, .spotlight, .magnifier:
            // Filled-ish regions accept clicks near the border OR inside for the
            // translucent / opaque kinds (which read as solid objects).
            let outer = rect.insetBy(dx: -slop, dy: -slop)
            if kind == .highlight || kind == .mosaic || kind == .spotlight || kind == .magnifier {
                return outer.contains(p)
            }
            let inner = rect.insetBy(dx: slop, dy: slop)
            return outer.contains(p) && !(inner.width > 0 && inner.height > 0 && inner.contains(p))
        case .arrow:
            if control == nil { return p.distanceToSegment(start, end) < slop + lineWidth }
            // Curved: test against the sampled polyline.
            let pts = QuadCurve.sample(start, arrowControl, end, steps: 24)
            for i in 1..<pts.count where p.distanceToSegment(pts[i - 1], pts[i]) < slop + lineWidth {
                return true
            }
            return false
        case .line:
            return p.distanceToSegment(start, end) < slop + lineWidth
        case .freehand, .polyline:
            guard let pts = points, pts.count > 1 else { return false }
            for i in 1..<pts.count where p.distanceToSegment(pts[i - 1], pts[i]) < slop + lineWidth {
                return true
            }
            return false
        case .text:
            let size = textBounds()
            return CGRect(origin: start, size: size).insetBy(dx: -slop, dy: -slop).contains(p)
        case .badge:
            return p.distance(to: start) < badgeRadius + slop
        case .watermark:
            // Tiled across the whole shot — not selectable via the canvas (it would
            // swallow every click); manage it from the layers panel / property bar.
            return false
        }
    }

    /// Resolved AppKit font for text / watermark: the chosen family at `fontSize`,
    /// falling back to the semibold system font when none / unavailable.
    func resolvedNSFont() -> NSFont {
        if let family = fontFamily, !family.isEmpty,
           let f = NSFont(name: family, size: fontSize) {
            return f
        }
        return NSFont.systemFont(ofSize: fontSize, weight: .semibold)
    }

    /// Approximate text extent (for hit-testing / selection box).
    func textBounds() -> CGSize {
        let str = (text?.isEmpty == false ? text! : "文字")
        let font = resolvedNSFont()
        let bounds = (str as NSString).boundingRect(
            with: CGSize(width: 600, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin],
            attributes: [.font: font])
        return CGSize(width: ceil(bounds.width) + 4, height: ceil(bounds.height) + 2)
    }

    mutating func translate(by delta: CGSize) {
        start.x += delta.width; start.y += delta.height
        end.x += delta.width; end.y += delta.height
        if let c = control {
            control = CGPoint(x: c.x + delta.width, y: c.y + delta.height)
        }
        if let pts = points {
            points = pts.map { CGPoint(x: $0.x + delta.width, y: $0.y + delta.height) }
        }
    }

    /// Map every stored coordinate through `f` (used to rotate the canvas). The
    /// rect kinds keep their two opposite corners — `rect` re-normalizes order.
    mutating func transformPoints(_ f: (CGPoint) -> CGPoint) {
        start = f(start)
        end = f(end)
        if let c = control { control = f(c) }
        if let pts = points { points = pts.map(f) }
    }
}

// MARK: - Editor state

/// The screenshot editor's document: the annotation list plus tool/style
/// selection and snapshot-based undo. `@MainActor` like every other UI store.
@MainActor
final class AnnotationEditorState: ObservableObject {
    @Published var annotations: [Annotation] = []
    @Published var selectedID: UUID?
    /// Active canvas tool. Starts in select mode so a fresh selection can be
    /// adjusted (drag handles / move) before drawing — picking a tool from the
    /// toolbar is a deliberate second step.
    @Published var tool: CanvasTool = .select
    @Published var color: AnnotationColor = .red
    /// Custom colour override for new annotations (`#RRGGBB`); nil = use `color`.
    @Published var colorHex: String?
    @Published var lineWidth: CGFloat = 3
    @Published var fontSize: CGFloat = 18
    /// Fill new rect / ellipse instead of outlining them.
    @Published var filled: Bool = false
    /// Dash style new outlined shapes get.
    @Published var dash: LineDashStyle = .solid
    /// Corner radius new rect / spotlight get.
    @Published var cornerRadius: CGFloat = 0
    /// Arrow style new arrows get.
    @Published var arrowType: ArrowType = .filled
    /// Arrow head size multiplier new arrows get.
    @Published var arrowHeadScale: CGFloat = 1
    /// Font family new text / watermark get (nil = system font).
    @Published var fontFamily: String?
    /// Magnifier zoom new lenses get.
    @Published var magnification: CGFloat = 2
    /// Magnifier lens shape new lenses get (round when true).
    @Published var lensRound: Bool = true
    /// Watermark tile style new watermarks get.
    @Published var watermarkOpacity: CGFloat = 0.18
    @Published var watermarkAngle: CGFloat = -30
    @Published var watermarkSpacing: CGFloat = 120
    /// The in-progress polyline (multi-click). Lives here (not in the canvas view)
    /// so the draw loop and the keyboard bus both see it; its last point trails the
    /// cursor as a preview until committed.
    @Published var draftPolyline: Annotation?
    /// Text annotation currently being edited in-place (shows a TextField).
    @Published var editingTextID: UUID?
    /// Whether the layers panel is open.
    @Published var layersOpen = false

    /// The kind whose properties the property bar edits: the current selection
    /// wins, else the active draw tool (nil in select / erase with nothing selected).
    var activeKind: AnnotationKind? { selected?.kind ?? tool.drawKind }

    /// The colour new annotations get (custom hex wins over the preset).
    var drawColor: Color {
        colorHex.flatMap(Color.init(hex:)) ?? color.color
    }

    /// Apply a preset colour to the pen (and any current selection).
    func applyPreset(_ c: AnnotationColor) {
        color = c
        colorHex = nil
        if let id = selectedID { update(id: id) { $0.color = c; $0.colorHex = nil } }
    }

    /// Apply a custom colour to the pen (and any current selection).
    func applyCustom(hex: String) {
        colorHex = hex
        if let id = selectedID { update(id: id) { $0.colorHex = hex } }
    }

    // Style setters: each updates the pen default AND the current selection, so
    // tweaking a control retargets whatever is selected (like `applyPreset`).
    func setLineWidth(_ w: CGFloat) {
        lineWidth = w
        if let id = selectedID { update(id: id) { $0.lineWidth = w } }
    }

    func setFontSize(_ s: CGFloat) {
        fontSize = s
        if let id = selectedID { update(id: id) { $0.fontSize = s } }
    }

    func setFilled(_ f: Bool) {
        filled = f
        if let id = selectedID { update(id: id) { $0.filled = f } }
    }

    func setDash(_ d: LineDashStyle) {
        dash = d
        if let id = selectedID { update(id: id) { $0.dash = d } }
    }

    func setCornerRadius(_ r: CGFloat) {
        cornerRadius = r
        if let id = selectedID { update(id: id) { $0.cornerRadius = r } }
    }

    func setArrowType(_ t: ArrowType) {
        arrowType = t
        if let id = selectedID { update(id: id) { $0.arrowType = t } }
    }

    func setArrowHeadScale(_ s: CGFloat) {
        arrowHeadScale = s
        if let id = selectedID { update(id: id) { $0.arrowHeadScale = s } }
    }

    func setFontFamily(_ family: String?) {
        let normalized = (family?.isEmpty == true) ? nil : family
        fontFamily = normalized
        if let id = selectedID { update(id: id) { $0.fontFamily = normalized } }
    }

    func setMagnification(_ m: CGFloat) {
        magnification = m
        if let id = selectedID { update(id: id) { $0.magnification = m } }
    }

    func setLensRound(_ round: Bool) {
        lensRound = round
        if let id = selectedID { update(id: id) { $0.lensRound = round } }
    }

    func setWatermarkOpacity(_ o: CGFloat) {
        watermarkOpacity = o
        if let id = selectedID { update(id: id) { $0.watermarkOpacity = o } }
    }

    func setWatermarkAngle(_ a: CGFloat) {
        watermarkAngle = a
        if let id = selectedID { update(id: id) { $0.watermarkAngle = a } }
    }

    func setWatermarkSpacing(_ s: CGFloat) {
        watermarkSpacing = s
        if let id = selectedID { update(id: id) { $0.watermarkSpacing = s } }
    }

    /// Update the text of the current selection (used by the watermark property
    /// bar, whose object isn't editable in-place on the canvas).
    func setSelectedText(_ text: String) {
        if let id = selectedID { update(id: id) { $0.text = text } }
    }

    // MARK: Polyline (multi-click) — the draft trails the cursor between clicks.

    var isDrawingPolyline: Bool { draftPolyline != nil }

    /// First click: seed a two-point draft (anchor + a preview point at the cursor).
    func beginPolyline(at p: CGPoint) {
        draftPolyline = Annotation(kind: .polyline, start: p, end: p, points: [p, p],
                                   color: color, colorHex: colorHex,
                                   lineWidth: lineWidth, dash: dash)
    }

    /// Freeze the trailing preview point at `p`, then append a fresh preview point.
    func appendPolylinePoint(at p: CGPoint) {
        guard var d = draftPolyline, var pts = d.points, !pts.isEmpty else { return }
        pts[pts.count - 1] = p
        pts.append(p)
        d.points = pts
        d.end = p
        draftPolyline = d
    }

    /// Move the trailing preview point to follow the cursor.
    func updatePolylinePreview(to p: CGPoint) {
        guard var d = draftPolyline, var pts = d.points, !pts.isEmpty else { return }
        pts[pts.count - 1] = p
        d.points = pts
        d.end = p
        draftPolyline = d
    }

    /// Drop the trailing preview and commit — needs ≥2 real vertices, else discard.
    func commitPolyline() {
        guard var d = draftPolyline, var pts = d.points else { draftPolyline = nil; return }
        if !pts.isEmpty { pts.removeLast() }          // the trailing preview point
        guard pts.count >= 2 else { draftPolyline = nil; return }
        d.points = pts
        d.start = pts.first ?? d.start
        d.end = pts.last ?? d.end
        snapshot()
        add(d)
        selectedID = d.id
        draftPolyline = nil
    }

    func cancelPolyline() {
        draftPolyline = nil
    }

    /// Ensure a single watermark exists and is selected (the watermark tool stamps
    /// one tiled object; re-activating the tool re-selects it for editing).
    func ensureWatermark() {
        if let existing = annotations.last(where: { $0.kind == .watermark }) {
            selectedID = existing.id
            return
        }
        snapshot()
        let w = Annotation(kind: .watermark, start: .zero, end: .zero,
                           text: "机密", color: color, colorHex: colorHex,
                           fontSize: max(fontSize, 22), fontFamily: fontFamily,
                           watermarkOpacity: watermarkOpacity, watermarkAngle: watermarkAngle,
                           watermarkSpacing: watermarkSpacing)
        add(w)
        selectedID = w.id
    }

    /// Erase the topmost annotation under a point (one undo per gesture — the
    /// caller snapshots at gesture start).
    func eraseAt(_ p: CGPoint) {
        guard let hit = hitTest(p) else { return }
        annotations.removeAll { $0.id == hit.id }
        if selectedID == hit.id { selectedID = nil }
        if editingTextID == hit.id { editingTextID = nil }
    }

    private var undoStack: [[Annotation]] = []
    private var redoStack: [[Annotation]] = []

    var selected: Annotation? {
        selectedID.flatMap { id in annotations.first { $0.id == id } }
    }

    var nextBadgeNumber: Int {
        (annotations.compactMap(\.number).max() ?? 0) + 1
    }

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    /// Push the current document before a mutation (drag-create commits once,
    /// at gesture start — not per movement frame).
    func snapshot() {
        undoStack.append(annotations)
        if undoStack.count > 100 { undoStack.removeFirst() }
        redoStack.removeAll()
    }

    func undo() {
        guard let prev = undoStack.popLast() else { return }
        redoStack.append(annotations)
        annotations = prev
        selectedID = nil
        editingTextID = nil
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(annotations)
        annotations = next
        selectedID = nil
    }

    func add(_ annotation: Annotation) {
        annotations.append(annotation)
    }

    func update(id: UUID, _ mutate: (inout Annotation) -> Void) {
        guard let i = annotations.firstIndex(where: { $0.id == id }) else { return }
        mutate(&annotations[i])
    }

    func remove(id: UUID) {
        snapshot()
        annotations.removeAll { $0.id == id }
        if selectedID == id { selectedID = nil }
        if editingTextID == id { editingTextID = nil }
    }

    func removeSelected() {
        if let id = selectedID { remove(id: id) }
    }

    /// Z-order = array order (later = drawn on top). The layers panel lists them
    /// front-first, so "上移" moves toward the end of the array.
    func bringForward(id: UUID) {
        guard let i = annotations.firstIndex(where: { $0.id == id }), i < annotations.count - 1 else { return }
        snapshot()
        annotations.swapAt(i, i + 1)
    }

    func sendBackward(id: UUID) {
        guard let i = annotations.firstIndex(where: { $0.id == id }), i > 0 else { return }
        snapshot()
        annotations.swapAt(i, i - 1)
    }

    func clearAll() {
        guard !annotations.isEmpty else { return }
        snapshot()
        annotations.removeAll()
        selectedID = nil
        editingTextID = nil
    }

    /// Topmost annotation under a point (drawing order = z-order).
    func hitTest(_ p: CGPoint) -> Annotation? {
        annotations.reversed().first { $0.hitTest(p) }
    }

    /// Map every annotation's coordinates (live list AND the undo/redo history) by
    /// `f`, so a canvas rotation stays consistent through undo. No new snapshot —
    /// rotation is reversed by rotating back, not by ⌘Z.
    func transformAll(_ f: (CGPoint) -> CGPoint) {
        for i in annotations.indices { annotations[i].transformPoints(f) }
        let map: ([Annotation]) -> [Annotation] = { snap in
            snap.map { var a = $0; a.transformPoints(f); return a }
        }
        undoStack = undoStack.map(map)
        redoStack = redoStack.map(map)
    }
}

// MARK: - Geometry helpers

/// Parsed sRGB components (0–1) of a `#RGB` / `#RRGGBB` string.
struct RGBComponents {
    let r, g, b: CGFloat

    init?(hex: String) {
        var s = hex.trimmed
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }   // #abc → #aabbcc
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        r = CGFloat((v >> 16) & 0xFF) / 255
        g = CGFloat((v >> 8) & 0xFF) / 255
        b = CGFloat(v & 0xFF) / 255
    }
}

extension Color {
    init?(hex: String) {
        guard let c = RGBComponents(hex: hex) else { return nil }
        self = Color(.sRGB, red: c.r, green: c.g, blue: c.b)
    }

    /// `#RRGGBB` for persistence (via NSColor so any SwiftUI Color resolves).
    var hexString: String? {
        guard let ns = NSColor(self).usingColorSpace(.sRGB) else { return nil }
        return String(format: "#%02X%02X%02X",
                      Int(round(ns.redComponent * 255)),
                      Int(round(ns.greenComponent * 255)),
                      Int(round(ns.blueComponent * 255)))
    }
}

/// Quadratic Bézier helpers shared by the arrow renderer and hit-testing.
enum QuadCurve {
    static func point(_ p0: CGPoint, _ c: CGPoint, _ p1: CGPoint, _ t: CGFloat) -> CGPoint {
        let u = 1 - t
        let a = u * u, b = 2 * u * t, d = t * t
        return CGPoint(x: a * p0.x + b * c.x + d * p1.x,
                       y: a * p0.y + b * c.y + d * p1.y)
    }

    static func sample(_ p0: CGPoint, _ c: CGPoint, _ p1: CGPoint, steps: Int) -> [CGPoint] {
        (0...steps).map { point(p0, c, p1, CGFloat($0) / CGFloat(steps)) }
    }
}

extension CGPoint {
    func distance(to other: CGPoint) -> CGFloat {
        hypot(x - other.x, y - other.y)
    }

    /// Distance from self to the segment a–b.
    func distanceToSegment(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
        let ab = CGPoint(x: b.x - a.x, y: b.y - a.y)
        let len2 = ab.x * ab.x + ab.y * ab.y
        guard len2 > 0 else { return distance(to: a) }
        let t = max(0, min(1, ((x - a.x) * ab.x + (y - a.y) * ab.y) / len2))
        return distance(to: CGPoint(x: a.x + t * ab.x, y: a.y + t * ab.y))
    }
}
