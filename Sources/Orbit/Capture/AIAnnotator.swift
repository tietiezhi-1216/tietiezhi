//  AIAnnotator.swift
//  The chat-to-annotate session: the user types an instruction under the
//  selection, the cropped region (plus local-OCR coordinate anchors) goes to
//  the configured multimodal chat model, and the model draws by CALLING TOOLS
//  (add_arrow / add_rect / …) whose results land as ordinary editable
//  annotations on the canvas. Reuses the standard ChatClient tool loop — the
//  same wire adapters as the chat surface, no new protocol code.

import AppKit
import SwiftUI

@MainActor
final class AIAnnotationSession: ObservableObject {

    enum Phase: Equatable {
        case idle
        case running(String)   // status word shown in the bar（识别中 / 标注中）
        case failed(String)
        case done(String)      // model's final short reply
    }

    @Published var phase: Phase = .idle
    @Published var input = ""
    /// The most recent instruction sent — recorded into screenshot history.
    private(set) var lastInstruction: String?

    private let settings: SettingsStore
    private let usage: UsageStore?
    private var messages: [ChatMessage] = []
    private var task: Task<Void, Never>?
    private var imagePath: String?
    /// OCR lines from the crop, kept so tool calls can snap to nearby text boxes
    /// (deterministic correction for the vision model's coordinate drift).
    private var anchors: [OCRLine] = []

    /// Vision models are weak at raw pixel coordinates, so everything speaks a
    /// normalized 0–1000 grid; OCR anchors ground it further.
    private static let grid: CGFloat = 1000

    init(settings: SettingsStore, usage: UsageStore?) {
        self.settings = settings
        self.usage = usage
    }

    var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    func cancel() {
        task?.cancel()
        task = nil
        if isRunning { phase = .idle }
    }

    /// Forget the conversation entirely (the crop it was grounded in is gone —
    /// e.g. after re-framing the selection).
    func reset() {
        cancel()
        messages.removeAll()
        anchors.removeAll()
        imagePath = nil
        lastInstruction = nil
        input = ""
        phase = .idle
    }

    /// Kick off (or continue) the annotate conversation for the current crop.
    /// `axNodes` are the Accessibility UI elements inside the selection (crop-local
    /// points) — precise, labelled anchors that beat pixel-grid guessing.
    func send(crop: CGImage, cropPointSize: CGSize, editor: AnnotationEditorState,
              axNodes: [AXNode] = []) {
        let instruction = input.trimmed
        guard !instruction.isEmpty, !isRunning else { return }
        guard let model = settings.settings.captureAnnotationModel,
              let resolved = settings.settings.resolve(model) else {
            phase = .failed("尚未选择标注模型：请在「截图 › 基础 › AI 标注」选一个大模型，或先在「渠道商」配置。")
            return
        }
        guard model.llmCapabilities.multimodal else {
            phase = .failed("当前模型未开启「多模态」能力，无法看到截图。请在渠道商的模型设置里开启，或换用视觉模型。")
            return
        }
        guard resolved.wire != .openAIResponses else {
            phase = .failed("OpenAI Responses 协议暂不支持工具调用，请给该模型换用 Chat Completions 协议。")
            return
        }

        input = ""
        lastInstruction = instruction
        phase = .running("正在观察截图")
        let modelConfig = model

        task = Task { [weak self, weak editor] in
            guard let self, let editor else { return }
            do {
                try await self.run(instruction: instruction, crop: crop,
                                   cropPointSize: cropPointSize, editor: editor,
                                   resolved: resolved, modelConfig: modelConfig, axNodes: axNodes)
            } catch is CancellationError {
                self.phase = .idle
            } catch {
                self.phase = .failed(error.localizedDescription)
            }
        }
    }

    // MARK: - The tool loop

    private func run(instruction: String, crop: CGImage, cropPointSize: CGSize,
                     editor: AnnotationEditorState, resolved: ResolvedModel,
                     modelConfig: ModelConfig, axNodes: [AXNode] = []) async throws {
        // First round of a session: system prompt + gridded image + OCR + AX anchors.
        if messages.isEmpty {
            // OCR first — its boxes both anchor the prompt and snap tool output.
            if let lines = try? await OCRService.recognize(in: crop, pointSize: cropPointSize) {
                anchors = lines
            }
            let path = try writeGridImage(crop, pointSize: cropPointSize)
            imagePath = path
            let anchorText = anchors.isEmpty ? "" : Self.anchorBlock(anchors, cropSize: cropPointSize)
            let nodeText = axNodes.isEmpty ? "" : Self.axAnchorBlock(axNodes, cropSize: cropPointSize)
            messages.append(ChatMessage(role: .system, content: Self.systemPrompt))
            messages.append(ChatMessage(
                role: .user,
                content: Self.firstTurn(instruction: instruction, anchors: anchorText,
                                        nodes: nodeText, cropSize: cropPointSize),
                attachments: [path]))
        } else {
            messages.append(ChatMessage(
                role: .user,
                content: instruction + "\n\n" + Self.stateBlock(editor.annotations, cropSize: cropPointSize)))
        }

        phase = .running("AI 标注中")
        var rounds = 0
        var finalText = ""

        while rounds < 4 {
            rounds += 1
            try Task.checkCancellation()

            var streamed = ""
            let outcome = try await ChatClient.stream(
                model: resolved,
                messages: messages,
                tools: Self.toolSpecs
            ) { delta in
                streamed += delta
            }
            try Task.checkCancellation()

            usage?.add(settings.settings.usageRecord(
                for: modelConfig, source: "截图 AI 标注", date: Date(), usage: outcome.usage))

            if outcome.toolCalls.isEmpty {
                finalText = streamed
                messages.append(ChatMessage(role: .assistant, content: streamed))
                break
            }

            messages.append(ChatMessage(role: .assistant, content: streamed,
                                        toolCalls: outcome.toolCalls))
            editor.snapshot()
            for call in outcome.toolCalls {
                try Task.checkCancellation()
                let result = apply(call, cropSize: cropPointSize, editor: editor)
                messages.append(ChatMessage(
                    role: .tool, content: "",
                    toolResult: ToolResult(toolCallID: call.id, content: result, isError: false)))
                // Staggered appearance — the "AI is drawing" beat.
                try? await Task.sleep(nanoseconds: 130_000_000)
            }
            if !streamed.isEmpty { finalText = streamed }
        }

        let summary = finalText.trimmed
        phase = .done(summary.isEmpty ? "已完成标注，可继续输入调整。" : summary)
    }

    /// Execute one tool call → one annotation (or a clear). Returns the result
    /// string fed back to the model.
    private func apply(_ call: ToolCall, cropSize: CGSize, editor: AnnotationEditorState) -> String {
        guard let args = (try? JSONSerialization.jsonObject(
            with: Data(call.argumentsJSON.utf8))) as? [String: Any] else {
            return "{\"error\":\"arguments 不是合法 JSON\"}"
        }

        func num(_ key: String) -> CGFloat? {
            (args[key] as? NSNumber).map { CGFloat(truncating: $0) }
        }
        /// 0–1000 grid → crop points, clamped inside the image.
        func px(_ v: CGFloat) -> CGFloat { min(max(0, v), Self.grid) / Self.grid * cropSize.width }
        func py(_ v: CGFloat) -> CGFloat { min(max(0, v), Self.grid) / Self.grid * cropSize.height }
        func color(default fallback: AnnotationColor = .red) -> AnnotationColor {
            (args["color"] as? String).flatMap(AnnotationColor.init(rawValue:)) ?? fallback
        }
        func rectAnnotation(_ kind: AnnotationKind, _ fallback: AnnotationColor = .red) -> Annotation? {
            guard let x = num("x"), let y = num("y"),
                  let w = num("width"), let h = num("height"), w > 0, h > 0 else { return nil }
            let raw = CGRect(x: px(x), y: py(y), width: px(x + w) - px(x), height: py(y + h) - py(y))
            let rect = snapRect(raw, cropSize: cropSize)
            // filled / style / thickness only matter for rect & ellipse; others ignore.
            let filled = (args["filled"] as? Bool) ?? false
            let dash = (args["style"] as? String).flatMap(LineDashStyle.init(rawValue:)) ?? .solid
            let width = num("thickness").map { min(max(1, $0), 20) } ?? editor.lineWidth
            // Spotlight reads nicer with a soft corner; rects stay sharp unless asked.
            let corner: CGFloat = kind == .spotlight ? 10 : 0
            return Annotation(kind: kind,
                              start: rect.origin,
                              end: CGPoint(x: rect.maxX, y: rect.maxY),
                              color: color(default: fallback),
                              lineWidth: width, fontSize: editor.fontSize,
                              filled: filled, dash: dash, cornerRadius: corner)
        }

        var made: Annotation?
        switch call.name {
        case "add_arrow":
            guard let fx = num("from_x"), let fy = num("from_y"),
                  let tx = num("to_x"), let ty = num("to_y") else { break }
            let tip = snapArrowTip(CGPoint(x: px(tx), y: py(ty)), cropSize: cropSize)
            let width = num("thickness").map { min(max(1, $0), 20) } ?? editor.lineWidth
            let atype = (args["type"] as? String).flatMap(ArrowType.init(rawValue:)) ?? editor.arrowType
            made = Annotation(kind: .arrow,
                              start: CGPoint(x: px(fx), y: py(fy)),
                              end: tip,
                              color: color(), lineWidth: width, fontSize: editor.fontSize,
                              arrowType: atype)
        case "add_rect":
            made = rectAnnotation(.rect)
        case "add_ellipse":
            made = rectAnnotation(.ellipse)
        case "add_highlight":
            made = rectAnnotation(.highlight, .yellow)
        case "add_mosaic":
            made = rectAnnotation(.mosaic)
        case "add_spotlight":
            made = rectAnnotation(.spotlight)
        case "add_text":
            guard let x = num("x"), let y = num("y"),
                  let text = args["text"] as? String, !text.isEmpty else { break }
            let size: CGFloat
            switch args["size"] as? String {
            case "small": size = 13
            case "large": size = 26
            default:      size = 18
            }
            made = Annotation(kind: .text,
                              start: CGPoint(x: px(x), y: py(y)),
                              end: CGPoint(x: px(x), y: py(y)),
                              text: text, color: color(), lineWidth: editor.lineWidth, fontSize: size)
        case "add_badge":
            guard let x = num("x"), let y = num("y") else { break }
            let n = (args["number"] as? NSNumber)?.intValue ?? editor.nextBadgeNumber
            made = Annotation(kind: .badge,
                              start: CGPoint(x: px(x), y: py(y)),
                              end: CGPoint(x: px(x), y: py(y)),
                              number: n, color: color(),
                              lineWidth: editor.lineWidth, fontSize: editor.fontSize)
        case "clear_annotations":
            editor.clearAll()
            return "{\"status\":\"ok\",\"note\":\"已清空全部标注\"}"
        default:
            return "{\"error\":\"未知工具 \(call.name)\"}"
        }

        guard let annotation = made else {
            return "{\"error\":\"参数缺失或非法（坐标须为 0–1000 的数字）\"}"
        }
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            editor.add(annotation)
        }
        return "{\"status\":\"ok\"}"
    }

    // MARK: - Anchor snapping (deterministic correction)

    /// Tighten a target rect onto the OCR text it clearly contains — fixes the
    /// vision model's small offsets. Conservative: fires only when text centres
    /// fall inside the model's rect, and never shrinks a deliberately large region.
    private func snapRect(_ rect: CGRect, cropSize: CGSize) -> CGRect {
        let inside = anchors.filter { rect.contains(CGPoint(x: $0.rect.midX, y: $0.rect.midY)) }
        guard !inside.isEmpty else { return rect }
        var box = inside[0].rect
        for a in inside.dropFirst() { box = box.union(a.rect) }
        let padX = max(cropSize.width * 0.015, 8)
        let padY = max(cropSize.height * 0.015, 8)
        let snapped = box.insetBy(dx: -padX, dy: -padY)
            .intersection(CGRect(origin: .zero, size: cropSize))
        guard snapped.width > 6, snapped.height > 6 else { return rect }
        // The model deliberately framed a much larger area (many elements) → keep it.
        if rect.width > snapped.width * 2.4, rect.height > snapped.height * 2.4 { return rect }
        return snapped
    }

    /// Pull an arrow tip onto the nearest OCR box when it's already aimed close to
    /// one. Small threshold → only refines clear near-misses (won't hijack arrows
    /// pointing at non-text UI).
    private func snapArrowTip(_ tip: CGPoint, cropSize: CGSize) -> CGPoint {
        guard !anchors.isEmpty else { return tip }
        let threshold = hypot(cropSize.width, cropSize.height) * 0.05
        var best: (d: CGFloat, rect: CGRect)?
        for a in anchors {
            let onBox = CGPoint(x: min(max(tip.x, a.rect.minX), a.rect.maxX),
                                y: min(max(tip.y, a.rect.minY), a.rect.maxY))
            let d = tip.distance(to: onBox)
            if best == nil || d < best!.d { best = (d, a.rect) }
        }
        // d == 0 means the tip is already inside a box — leave it untouched.
        guard let b = best, b.d > 0.5, b.d < threshold else { return tip }
        return CGPoint(x: min(max(tip.x, b.rect.minX), b.rect.maxX),
                       y: min(max(tip.y, b.rect.minY), b.rect.maxY))
    }

    // MARK: - Prompt assembly

    private static let systemPrompt = """
    你是 Orbit 截图工具内置的标注助手。用户刚截取了一块屏幕区域，你能看到这张截图。\
    你的任务是根据用户的指令，调用工具在截图上画标注（箭头、框、文字等）。

    ⚠️ 坐标系统（务必严格遵守，位置画偏是最常见的错误）：
    - 每个坐标轴都独立归一化到 0–1000：x 从左到右 0→1000，y 从上到下 0→1000（左上角=(0,0)，右下角=(1000,1000)）。\
    这与图片的真实宽高比无关——同一个数字 500 在 x 上表示「水平中点」，在 y 上表示「垂直中点」。
    - 截图上叠加了一层浅色参考网格，每 100 一格、边缘标注了 0/200/400/…/1000 刻度。\
    **请直接读取网格刻度来确定坐标**，不要凭感觉估。先在网格上定位目标的左右边界（x）和上下边界（y），再填参数。
    - 矩形/椭圆/高亮/马赛克用 (x, y, width, height)：x,y 是左上角，width/height 是「尺寸/跨度」，不是右下角坐标。\
    例：目标横跨 x 从 300 到 700、y 从 400 到 500，则 x=300, y=400, width=400, height=100。
    - 箭头 from 是尾巴（放在空白处），to 是尖端（精确落在目标上）。别把两者画反。
    - 用户消息里可能附带两类锚点：**界面元素节点**（系统辅助功能读到的按钮/输入框/文字等控件的角色、文字与精确位置）和 OCR 文字。\
    只要目标能对上某个节点或 OCR 锚点，**直接采用它的坐标**——节点优先，这是比看图估算准得多的来源。

    标注美学要求：
    - 标注要克制、清晰，不要遮挡它想指向的内容：框稍微比目标大一圈；文字放在目标旁边的空白处；\
    箭头从空白处指向目标，不要横穿重要内容。
    - 未指定颜色时默认 red；同一批相关标注保持同色；序号标记从 1 开始递增。
    - 打码（add_mosaic）时区域要完整覆盖敏感内容并略微出血。

    完成标注后，用一句简短中文总结你做了什么。如果指令与截图无关或无法完成，直接用中文说明，不调用工具。
    """

    private static func firstTurn(instruction: String, anchors: String,
                                  nodes: String, cropSize: CGSize) -> String {
        var text = "用户指令：\(instruction)"
        text += "\n\n截图实际像素约为 \(Int(cropSize.width))×\(Int(cropSize.height))（宽×高，仅供判断形状/比例）；"
        text += "所有工具坐标仍用 0–1000 归一化网格，图上已叠加刻度线，请照着刻度读数。"
        if !nodes.isEmpty {
            text += "\n\n以下是通过系统辅助功能读到的【界面元素节点】（0–1000 网格，格式 角色「文字」(x,y,宽,高)）——这是最精确的定位来源，位置是系统实测而非猜测。要圈/指某个按钮、输入框、文字等控件时，直接采用对应节点的坐标：\n" + nodes
        }
        if !anchors.isEmpty {
            text += "\n\n以下是 OCR 识别出的文字及其位置（同一 0–1000 网格，格式「文字」(x,y,宽,高)）——节点没覆盖到的文字用它补充：\n" + anchors
        }
        return text
    }

    private static func anchorBlock(_ lines: [OCRLine], cropSize: CGSize) -> String {
        lines.prefix(60).map { line in
            let r = line.rect
            let x = Int(r.minX / cropSize.width * grid)
            let y = Int(r.minY / cropSize.height * grid)
            let w = Int(r.width / cropSize.width * grid)
            let h = Int(r.height / cropSize.height * grid)
            return "「\(line.text)」(\(x),\(y),\(w),\(h))"
        }
        .joined(separator: "\n")
    }

    /// AX UI nodes → normalized anchor lines. Role is stripped of the "AX" prefix
    /// (Button/TextField/…) so the model reads them naturally.
    private static func axAnchorBlock(_ nodes: [AXNode], cropSize: CGSize) -> String {
        nodes.prefix(64).map { n in
            let r = n.frame
            let x = Int(r.minX / cropSize.width * grid)
            let y = Int(r.minY / cropSize.height * grid)
            let w = Int(r.width / cropSize.width * grid)
            let h = Int(r.height / cropSize.height * grid)
            let role = n.role.hasPrefix("AX") ? String(n.role.dropFirst(2)) : n.role
            let label = n.label.isEmpty ? "" : "「\(n.label)」"
            return "\(role)\(label)(\(x),\(y),\(w),\(h))"
        }
        .joined(separator: "\n")
    }

    /// Current canvas state, so follow-up turns can reason about what exists.
    private static func stateBlock(_ annotations: [Annotation], cropSize: CGSize) -> String {
        guard !annotations.isEmpty else { return "（画布当前没有标注。）" }
        let items = annotations.map { a -> String in
            let r = a.rect
            let x = Int(r.minX / cropSize.width * grid)
            let y = Int(r.minY / cropSize.height * grid)
            let w = Int(r.width / cropSize.width * grid)
            let h = Int(r.height / cropSize.height * grid)
            var desc = "\(a.kind.rawValue) \(a.color.rawValue) (\(x),\(y),\(w),\(h))"
            if let t = a.text { desc += " text=\"\(t)\"" }
            if let n = a.number { desc += " number=\(n)" }
            return "- " + desc
        }
        return "画布当前的标注（同一 1000 网格）：\n" + items.joined(separator: "\n")
            + "\n如需重画可先调用 clear_annotations。"
    }

    // MARK: - Tool declarations

    private static func coordProps(_ extra: [String: Any] = [:]) -> [String: Any] {
        var props: [String: Any] = [
            "x": ["type": "number", "description": "左上角 x（0–1000，照图上网格刻度读）"],
            "y": ["type": "number", "description": "左上角 y（0–1000）"],
            "width": ["type": "number", "description": "宽度/水平跨度（0–1000）——是尺寸，不是右边界坐标"],
            "height": ["type": "number", "description": "高度/垂直跨度（0–1000）——是尺寸，不是下边界坐标"],
            "color": colorProp,
        ]
        for (k, v) in extra { props[k] = v }
        return props
    }

    private static let colorProp: [String: Any] = [
        "type": "string",
        "enum": AnnotationColor.allCases.map(\.rawValue),
        "description": "标注颜色，默认 red",
    ]

    /// Optional fill / line-style / thickness knobs for outlined shapes (rect & ellipse).
    private static let shapeStyleProps: [String: Any] = [
        "filled": ["type": "boolean", "description": "是否填充（默认 false，只描边）"],
        "style": ["type": "string", "enum": LineDashStyle.allCases.map(\.rawValue),
                  "description": "线型：solid 实线 / dashed 虚线 / dotted 点线，默认 solid"],
        "thickness": ["type": "number", "description": "线条粗细，1–20，默认沿用当前设置"],
    ]

    static let toolSpecs: [ToolSpec] = [
        ToolSpec(name: "add_arrow",
                 description: "画一个箭头指向目标。from=尾巴(放在目标旁的空白处)，to=尖端(精确落在目标上)——别画反。坐标 0–1000，照网格刻度读。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "from_x": ["type": "number", "description": "尾巴 x（起点，放空白处）"],
                        "from_y": ["type": "number", "description": "尾巴 y"],
                        "to_x": ["type": "number", "description": "尖端 x，精确指向目标"],
                        "to_y": ["type": "number", "description": "尖端 y"],
                        "color": colorProp,
                        "thickness": ["type": "number", "description": "箭头粗细，1–20，默认沿用当前设置"],
                        "type": ["type": "string", "enum": ArrowType.allCases.map(\.rawValue),
                                 "description": "箭头类型：filled 实心 / line 线条，默认 filled"],
                    ] as [String: Any],
                    "required": ["from_x", "from_y", "to_x", "to_y"],
                 ]),
        ToolSpec(name: "add_rect",
                 description: "画一个矩形框圈住目标。默认描边不填充；框比目标略大一圈。x,y=左上角，width/height=尺寸。可选 filled 填充、style 线型。",
                 parameters: ["type": "object", "properties": coordProps(shapeStyleProps),
                              "required": ["x", "y", "width", "height"]]),
        ToolSpec(name: "add_ellipse",
                 description: "画一个椭圆圈住目标。默认描边不填充。x,y=外接框左上角，width/height=外接框尺寸。可选 filled 填充、style 线型。",
                 parameters: ["type": "object", "properties": coordProps(shapeStyleProps),
                              "required": ["x", "y", "width", "height"]]),
        ToolSpec(name: "add_highlight",
                 description: "半透明荧光笔高亮一块区域（适合强调一行文字）。",
                 parameters: ["type": "object", "properties": coordProps(),
                              "required": ["x", "y", "width", "height"]]),
        ToolSpec(name: "add_mosaic",
                 description: "将一块区域打上马赛克（遮盖敏感信息）。",
                 parameters: ["type": "object", "properties": coordProps(),
                              "required": ["x", "y", "width", "height"]]),
        ToolSpec(name: "add_spotlight",
                 description: "聚光灯：压暗该区域【以外】的所有内容，把注意力聚焦到这块（突出一个区域又不遮挡它本身）。x,y=左上角，width/height=尺寸。",
                 parameters: ["type": "object", "properties": coordProps(),
                              "required": ["x", "y", "width", "height"]]),
        ToolSpec(name: "add_text",
                 description: "在指定位置写一段文字说明（放在目标旁边的空白处）。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "x": ["type": "number", "description": "文字左上角 x（0–1000）"],
                        "y": ["type": "number", "description": "文字左上角 y（0–1000）"],
                        "text": ["type": "string"],
                        "size": ["type": "string", "enum": ["small", "medium", "large"]],
                        "color": colorProp,
                    ] as [String: Any],
                    "required": ["x", "y", "text"],
                 ]),
        ToolSpec(name: "add_badge",
                 description: "放一个圆形序号标记（步骤 1、2、3…）。",
                 parameters: [
                    "type": "object",
                    "properties": [
                        "x": ["type": "number", "description": "圆心 x（0–1000）"],
                        "y": ["type": "number", "description": "圆心 y（0–1000）"],
                        "number": ["type": "integer", "description": "序号，缺省自动递增"],
                        "color": colorProp,
                    ] as [String: Any],
                    "required": ["x", "y"],
                 ]),
        ToolSpec(name: "clear_annotations",
                 description: "清空画布上的全部标注（重画前使用）。",
                 parameters: ["type": "object", "properties": [String: Any]()]),
    ]

    // MARK: - Temp image

    /// The vision payload: the crop downscaled to ≤1600px long side WITH a faint
    /// 0–1000 coordinate grid + edge tick labels drawn on top, so the model reads
    /// positions off a printed ruler instead of guessing. Written under ~/.orbit/tmp
    /// (ChatClient reads attachments from file paths). OCR still runs on the CLEAN
    /// crop, so the grid never pollutes the anchors.
    private func writeGridImage(_ crop: CGImage, pointSize: CGSize) throws -> String {
        let dir = SettingsStore.configDirectory().appendingPathComponent("tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("ai-annotate-\(UUID().uuidString).png")

        let maxSide: CGFloat = 1600
        let long = CGFloat(max(crop.width, crop.height))
        let k = min(1, maxSide / max(long, 1))
        let size = CGSize(width: CGFloat(crop.width) * k, height: CGFloat(crop.height) * k)

        let renderer = ImageRenderer(content: GridReferenceView(crop: crop, size: size))
        renderer.scale = 1
        renderer.isOpaque = true
        if let cg = renderer.cgImage {
            try cg.writePNG(to: url)
        } else {
            try crop.downscaled(maxSide: Int(maxSide)).writePNG(to: url)   // fallback: no grid
        }
        return url.path
    }

    /// Sweep stale temp payloads (called from CaptureEngine at launch).
    static func cleanTempImages() {
        let dir = SettingsStore.configDirectory().appendingPathComponent("tmp", isDirectory: true)
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
        for url in items where url.lastPathComponent.hasPrefix("ai-annotate-") {
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if date < cutoff { try? fm.removeItem(at: url) }
        }
    }
}

// MARK: - Grid reference image

/// The crop with a faint labelled 0–1000 coordinate grid painted on top — the
/// "ruler" the vision model reads positions off. Same drawing primitives as the
/// annotation canvas; rendered once via ImageRenderer into the vision payload.
private struct GridReferenceView: View {
    let crop: CGImage
    let size: CGSize

    var body: some View {
        ZStack {
            Image(decorative: crop, scale: 1)
                .resizable()
                .interpolation(.high)
                .frame(width: size.width, height: size.height)
            Canvas { ctx, sz in Self.drawGrid(&ctx, sz) }
                .frame(width: size.width, height: size.height)
        }
        .frame(width: size.width, height: size.height)
    }

    /// 10×10 grid (every 100 units) with the centre line emphasized; each line is
    /// drawn dark-then-light so it stays visible over any background.
    static func drawGrid(_ ctx: inout GraphicsContext, _ sz: CGSize) {
        let n = 10
        for i in 1..<n {
            let x = sz.width * CGFloat(i) / CGFloat(n)
            let y = sz.height * CGFloat(i) / CGFloat(n)
            var v = Path(); v.move(to: CGPoint(x: x, y: 0)); v.addLine(to: CGPoint(x: x, y: sz.height))
            var h = Path(); h.move(to: CGPoint(x: 0, y: y)); h.addLine(to: CGPoint(x: sz.width, y: y))
            let major = (i == 5)
            ctx.stroke(v, with: .color(.black.opacity(major ? 0.42 : 0.24)), lineWidth: 1.4)
            ctx.stroke(h, with: .color(.black.opacity(major ? 0.42 : 0.24)), lineWidth: 1.4)
            ctx.stroke(v, with: .color(.white.opacity(major ? 0.7 : 0.4)), lineWidth: 0.6)
            ctx.stroke(h, with: .color(.white.opacity(major ? 0.7 : 0.4)), lineWidth: 0.6)
        }
        // Tick labels every 200 — x along the top edge, y down the left edge.
        for i in stride(from: 0, through: n, by: 2) {
            let val = i * 100
            let x = sz.width * CGFloat(i) / CGFloat(n)
            let y = sz.height * CGFloat(i) / CGFloat(n)
            tick(&ctx, "\(val)", at: CGPoint(x: min(max(x, 14), sz.width - 14), y: 9))
            if i > 0 {   // skip 0 on the left so it doesn't collide with the top-left tick
                tick(&ctx, "\(val)", at: CGPoint(x: 14, y: min(max(y, 9), sz.height - 9)))
            }
        }
    }

    private static func tick(_ ctx: inout GraphicsContext, _ s: String, at p: CGPoint) {
        let text = Text(s).font(.system(size: 11, weight: .bold, design: .rounded)).foregroundColor(.white)
        let resolved = ctx.resolve(text)
        let m = resolved.measure(in: CGSize(width: 80, height: 40))
        let chip = CGRect(x: p.x - m.width / 2 - 3, y: p.y - m.height / 2 - 1,
                          width: m.width + 6, height: m.height + 2)
        ctx.fill(Path(roundedRect: chip, cornerRadius: 3), with: .color(.black.opacity(0.6)))
        ctx.draw(resolved, at: p, anchor: .center)
    }
}
