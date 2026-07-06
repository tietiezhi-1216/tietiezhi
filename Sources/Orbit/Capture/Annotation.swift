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
    case rect
    case ellipse
    case freehand   // `points`
    case text       // `text` anchored at `start`
    case highlight  // translucent marker block
    case mosaic     // pixelate the region underneath
    case badge      // numbered circle at `start`

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .arrow:     return "箭头"
        case .line:      return "直线"
        case .rect:      return "矩形"
        case .ellipse:   return "椭圆"
        case .freehand:  return "画笔"
        case .text:      return "文字"
        case .highlight: return "高亮"
        case .mosaic:    return "马赛克"
        case .badge:     return "序号"
        }
    }

    var symbol: String {
        switch self {
        case .arrow:     return "arrow.up.right"
        case .line:      return "line.diagonal"
        case .rect:      return "rectangle"
        case .ellipse:   return "circle"
        case .freehand:  return "pencil.and.scribble"
        case .text:      return "character.cursor.ibeam"
        case .highlight: return "highlighter"
        case .mosaic:    return "mosaic"
        case .badge:     return "1.circle"
        }
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
    var text: String?
    /// Badge number (序号).
    var number: Int?
    var color: AnnotationColor
    var lineWidth: CGFloat
    var fontSize: CGFloat

    init(id: UUID = UUID(), kind: AnnotationKind,
         start: CGPoint, end: CGPoint,
         points: [CGPoint]? = nil, text: String? = nil, number: Int? = nil,
         color: AnnotationColor = .red, lineWidth: CGFloat = 3, fontSize: CGFloat = 18) {
        self.id = id
        self.kind = kind
        self.start = start
        self.end = end
        self.points = points
        self.text = text
        self.number = number
        self.color = color
        self.lineWidth = lineWidth
        self.fontSize = fontSize
    }

    /// Normalized rect spanned by start/end.
    var rect: CGRect {
        CGRect(x: min(start.x, end.x), y: min(start.y, end.y),
               width: abs(end.x - start.x), height: abs(end.y - start.y))
    }

    var badgeRadius: CGFloat { max(11, fontSize * 0.68) }

    /// Generous hit area for selection (the canvas hit-tests back-to-front).
    func hitTest(_ p: CGPoint) -> Bool {
        let slop: CGFloat = 8
        switch kind {
        case .rect, .ellipse, .highlight, .mosaic:
            // Filled-ish regions accept clicks near the border OR inside for the
            // translucent kinds (which read as solid objects).
            let outer = rect.insetBy(dx: -slop, dy: -slop)
            if kind == .highlight || kind == .mosaic { return outer.contains(p) }
            let inner = rect.insetBy(dx: slop, dy: slop)
            return outer.contains(p) && !(inner.width > 0 && inner.height > 0 && inner.contains(p))
        case .arrow, .line:
            return p.distanceToSegment(start, end) < slop + lineWidth
        case .freehand:
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
        }
    }

    /// Approximate text extent (for hit-testing / selection box).
    func textBounds() -> CGSize {
        let str = (text?.isEmpty == false ? text! : "文字")
        let font = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
        let bounds = (str as NSString).boundingRect(
            with: CGSize(width: 600, height: CGFloat.greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin],
            attributes: [.font: font])
        return CGSize(width: ceil(bounds.width) + 4, height: ceil(bounds.height) + 2)
    }

    mutating func translate(by delta: CGSize) {
        start.x += delta.width; start.y += delta.height
        end.x += delta.width; end.y += delta.height
        if let pts = points {
            points = pts.map { CGPoint(x: $0.x + delta.width, y: $0.y + delta.height) }
        }
    }
}

// MARK: - Editor state

/// The screenshot editor's document: the annotation list plus tool/style
/// selection and snapshot-based undo. `@MainActor` like every other UI store.
@MainActor
final class AnnotationEditorState: ObservableObject {
    @Published var annotations: [Annotation] = []
    @Published var selectedID: UUID?
    /// Active drawing tool; nil = select / move mode.
    @Published var tool: AnnotationKind? = .arrow
    @Published var color: AnnotationColor = .red
    @Published var lineWidth: CGFloat = 3
    @Published var fontSize: CGFloat = 18
    /// Text annotation currently being edited in-place (shows a TextField).
    @Published var editingTextID: UUID?

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
}

// MARK: - Geometry helpers

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
