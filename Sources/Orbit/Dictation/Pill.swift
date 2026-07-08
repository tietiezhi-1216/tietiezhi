//  Pill.swift
//  The floating dictation indicator: a borderless, non-activating panel pinned
//  bottom-center, always on top, hosting a SwiftUI view. It morphs across the
//  dictation lifecycle — live mic level while recording, a sweeping "扫光" light
//  over the model's streamed text while thinking, a final confirmation when done.
//
//  The panel is intentionally larger than the capsule it draws: the capsule's
//  drop-shadow needs transparent margin to fade into, otherwise it gets clipped
//  to the window bounds and reads as a hard black rectangle around the pill.

import AppKit
import SwiftUI
import Combine

/// Where the pill is in the dictation lifecycle.
enum DictPhase: Equatable {
    case recording      // capturing audio; show live level
    case thinking       // ASR / polish running; show sweep + streamed text
    case done           // finished; brief confirmation
}

/// Observable state shared between the engine and the pill view.
@MainActor
final class PillState: ObservableObject {
    @Published var phase: DictPhase = .recording
    @Published var level: Float = 0
    /// Short status word shown while thinking ("Translate" / "Thinking").
    @Published var status: String = ""
    /// Latest streamed / final text, rendered in the middle while thinking.
    @Published var text: String = ""

    var onCancel: (() -> Void)?
    var onCommit: (() -> Void)?
}

enum NoticeMode {
    case action   // a plain action button (取消 / 关闭 …) that runs `onAction`
    case copy     // a 复制 button that copies `copyText` to the pasteboard
}

@MainActor
final class NoticeState: ObservableObject {
    @Published var title: String = ""
    @Published var message: String = ""
    @Published var hint: String = ""
    @Published var actionTitle: String = "取消"
    @Published var mode: NoticeMode = .action
    /// Text the 复制 button puts on the pasteboard (copy mode).
    @Published var copyText: String = ""
    /// When non-empty, a prominent secondary button (e.g. 去授权) is shown.
    @Published var authorizeTitle: String = ""

    var onClose: (() -> Void)?
    var onAction: (() -> Void)?
    var onAuthorize: (() -> Void)?
}

@MainActor
final class PillController {
    let state = PillState()
    private var panel: NSPanel?
    private let noticeState = NoticeState()
    private var noticePanel: NSPanel?
    private var noticeDismissTask: Task<Void, Never>?

    /// Transparent canvas sized to give the capsule's shadow room to fade (so it
    /// never clips to a hard rectangle) while keeping the invisible margin — and
    /// the click dead-zone it implies — as small as practical.
    private let panelSize = NSSize(width: 380, height: 84)

    var onCancel: (() -> Void)? {
        didSet { state.onCancel = onCancel }
    }
    var onCommit: (() -> Void)? {
        didSet { state.onCommit = onCommit }
    }
    var onNoticeAction: (() -> Void)?

    var isNoticeVisible: Bool {
        noticePanel?.isVisible == true
    }

    // MARK: - Lifecycle updates (called by the engine)

    func beginRecording() {
        state.phase = .recording
        state.level = 0
        state.status = ""
        state.text = ""
    }

    func recording(level: Float) {
        state.phase = .recording
        state.level = level
    }

    func beginThinking(_ status: String) {
        state.phase = .thinking
        state.status = status
    }

    /// Push the latest streamed text into the middle of the pill.
    func stream(_ text: String) {
        state.phase = .thinking
        state.text = text
    }

    func done(_ text: String) {
        state.phase = .done
        state.text = text
    }

    func show() {
        if panel == nil { build() }
        position()
        panel?.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    func showNotice(
        title: String,
        message: String,
        actionTitle: String = "取消",
        autoDismissAfter seconds: TimeInterval? = nil
    ) {
        if noticePanel == nil { buildNotice() }
        noticeDismissTask?.cancel()
        noticeState.mode = .action
        noticeState.hint = ""
        noticeState.authorizeTitle = ""
        noticeState.onAuthorize = nil
        noticeState.title = title
        noticeState.message = message
        noticeState.actionTitle = actionTitle
        positionNotice()
        noticePanel?.orderFrontRegardless()

        if let seconds {
            noticeDismissTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                guard !Task.isCancelled else { return }
                hideNotice()
            }
        }
    }

    /// A Typeless-style fallback: when the result can't be auto-inserted, show
    /// the recognized text with a 复制 button so the user can paste it anywhere.
    /// When `authorizeTitle`/`onAuthorize` are supplied, a prominent grant button
    /// is shown alongside (used when the blocker is a missing permission).
    func showCopyNotice(title: String, text: String, hint: String? = nil,
                        authorizeTitle: String? = nil, onAuthorize: (() -> Void)? = nil) {
        if noticePanel == nil { buildNotice() }
        noticeDismissTask?.cancel()
        noticeState.mode = .copy
        noticeState.copyText = text
        noticeState.title = title
        noticeState.message = "“\(text)”"
        noticeState.hint = hint ?? ""
        noticeState.authorizeTitle = authorizeTitle ?? ""
        noticeState.onAuthorize = onAuthorize
        noticeState.actionTitle = "复制"
        positionNotice()
        noticePanel?.orderFrontRegardless()
    }

    func hideNotice() {
        noticeDismissTask?.cancel()
        noticeDismissTask = nil
        noticePanel?.orderOut(nil)
    }

    // MARK: - Panel

    private func build() {
        let hosting = NSHostingView(rootView: PillView(state: state))
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = .clear
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: panelSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        // Above the screen-capture overlay (`.screenSaver`): dictation is global, so
        // the pill must stay visible even while the capture surface covers the whole
        // screen (e.g. dictating into the截图 AI 输入框). At `.statusBar` it hid behind
        // that overlay and looked broken.
        panel.level = Self.overlayLevel
        panel.backgroundColor = .clear
        panel.isOpaque = false
        // The shadow is drawn by SwiftUI (it follows the capsule shape). The
        // window-level shadow would be rectangular, so it stays off.
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = hosting
        self.panel = panel
    }

    private func position() {
        guard let panel, let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = panel.frame.size
        let x = visible.midX - size.width / 2
        // Hug the very bottom edge (capsule is bottom-anchored within the panel).
        let y = visible.minY + 2
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func buildNotice() {
        noticeState.onClose = { [weak self] in self?.hideNotice() }
        noticeState.onAction = { [weak self] in
            self?.hideNotice()
            self?.onNoticeAction?()
        }

        let hosting = NSHostingView(rootView: NoticeView(state: noticeState))
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 150),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = Self.overlayLevel   // above the capture overlay (see `build`)
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = hosting
        noticePanel = panel
    }

    /// One notch above the capture overlay's `.screenSaver` level, so the pill and
    /// its notices win against the full-screen capture surface.
    private static let overlayLevel = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)

    private func positionNotice() {
        guard let noticePanel, let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let size = noticePanel.frame.size
        let x = visible.midX - size.width / 2
        let y = visible.minY + 40
        noticePanel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// MARK: - SwiftUI content

struct PillView: View {
    @ObservedObject var state: PillState

    var body: some View {
        // Anchor the capsule to the BOTTOM of the (taller) panel so it hugs the
        // screen edge. The slack above is just shadow / morph headroom — it must
        // not push the capsule upward (that left a big gap below it and overlapped
        // the result deck).
        capsule
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 10)
    }

    private var isThinking: Bool { state.phase == .thinking }
    /// Thinking + done both use a fixed-width window so the text marquee has a
    /// stable area to scroll within; recording hugs its compact controls.
    private var isWide: Bool { state.phase == .thinking || state.phase == .done }

    private var capsule: some View {
        HStack(spacing: 8) {
            // Buttons only while recording — the conversion state hands the whole
            // capsule over to the streamed text.
            if state.phase == .recording {
                circleButton(system: "xmark", style: .cancel) { state.onCancel?() }
            }

            center

            if state.phase == .recording {
                circleButton(system: "checkmark", style: .commit) { state.onCommit?() }
            }
        }
        .padding(.horizontal, state.phase == .recording ? 6 : 14)
        .frame(height: 38)
        .frame(width: isWide ? 300 : nil)
        .background(capsuleBackground)
        .shadow(color: .black.opacity(0.38), radius: 16, x: 0, y: 7)
        .fixedSize(horizontal: !isWide, vertical: true)
        .animation(.spring(response: 0.34, dampingFraction: 0.85), value: state.phase)
    }

    /// The capsule fill, hairline, and — while thinking — the rotating edge light
    /// wave + a soft light sweeping across it.
    @ViewBuilder
    private var capsuleBackground: some View {
        ZStack {
            Capsule(style: .continuous).fill(Color.black.opacity(0.9))
            if isThinking {
                CapsuleSweep()
                    .clipShape(Capsule(style: .continuous))
            }
            Capsule(style: .continuous).strokeBorder(.white.opacity(0.09))
            if isThinking {
                CapsuleEdgeGlow()
            }
        }
    }

    // MARK: Center content per phase

    @ViewBuilder
    private var center: some View {
        switch state.phase {
        case .recording:
            LevelBars(level: state.level)
                .frame(width: 38)
        case .thinking:
            if state.text.isEmpty {
                ThinkingLabel(text: state.status.isEmpty ? "Translate" : state.status)
                    .frame(maxWidth: .infinity)
            } else {
                StreamingText(target: state.text)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .done:
            DoneContent(text: state.text)
        }
    }

    // MARK: Buttons

    private enum ButtonStyleKind {
        case cancel, commit

        var foreground: Color {
            switch self {
            case .cancel: return .white.opacity(0.9)
            case .commit: return .black.opacity(0.88)
            }
        }
        var background: Color {
            switch self {
            case .cancel: return Color.white.opacity(0.18)
            case .commit: return Color.white.opacity(0.94)
            }
        }
    }

    private func circleButton(system: String, style: ButtonStyleKind, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(style.foreground)
                .frame(width: 26, height: 26)
                .background(Circle().fill(style.background))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Recording: live level bars

private struct LevelBars: View {
    let level: Float
    private let barCount = 9

    var body: some View {
        HStack(spacing: 1.6) {
            ForEach(0..<barCount, id: \.self) { i in
                let center = Double(barCount - 1) / 2
                let falloff = 1 - abs(Double(i) - center) / Double(barCount)
                let base = CGFloat([7, 10, 14, 17, 20, 17, 14, 10, 7][i])
                let live = CGFloat(Double(level) * 10 * falloff)
                let h = min(22, max(5, base * 0.55 + live))
                Capsule()
                    .fill(Color.white.opacity(0.96))
                    .frame(width: 2, height: h)
                    .animation(.easeOut(duration: 0.08), value: level)
            }
        }
        .frame(height: 24)
    }
}

// MARK: - Thinking visuals

/// The placeholder shown before any text streams in ("Translate") — a label with a
/// light sweeping across it. The capsule's edge wave does the rest of the work.
private struct ThinkingLabel: View {
    let text: String
    @State private var phase: CGFloat = 0

    private var label: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
    }

    var body: some View {
        label
            .foregroundStyle(.white.opacity(0.45))
            .overlay {
                label
                    .foregroundStyle(.white)
                    .mask { SweepBand(phase: phase) }
            }
            .onAppear {
                phase = 0
                withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) {
                    phase = 1
                }
            }
    }
}

/// Streamed text rendered as a scrolling ticker: the line is pinned to its
/// trailing edge and the horizontal offset animates as text grows, so words
/// reveal progressively (滚动屏). Both ends fade (淡入淡出) — new words fade in at
/// the right as they arrive, old words fade out at the left as they scroll off.
/// Reveals `target` progressively (a typewriter), decoupled from how fast the
/// model actually delivers tokens — many OpenAI-compatible providers/proxies
/// buffer the SSE and dump the whole string at once, which would otherwise pop
/// in as one block. Here new glyphs are appended a few at a time and enter under
/// the soft right edge, hardening as they scroll left → an animated 渐变追加.
private struct StreamingText: View {
    let target: String
    @State private var shown: Int = 0
    @State private var ticker: Task<Void, Never>?

    /// Single line: collapse newlines so `lineLimit(1)` never truncates to "…".
    private var clean: String { target.replacingOccurrences(of: "\n", with: " ") }

    var body: some View {
        ScrollingLine(text: String(clean.prefix(shown)))
            .onAppear { pump() }
            .onChange(of: target) { _, _ in pump() }
            .onDisappear { ticker?.cancel(); ticker = nil }
    }

    private func pump() {
        ticker?.cancel()
        let full = clean.count
        ticker = Task { @MainActor in
            while shown < full {
                let remaining = full - shown
                // Catch up faster when a big chunk just landed; ease as it nears.
                shown = min(full, shown + max(1, remaining / 6))
                try? await Task.sleep(nanoseconds: 26_000_000)   // ~38 reveals/sec
                if Task.isCancelled { return }
            }
        }
    }
}

/// One line of text inside a fixed-width window, vertically centered:
///  • fits the window  → centered horizontally (no scroll).
///  • overflows        → slides left so the freshest (trailing) text stays in
///    view — a horizontal-ticker / 滚动公告 reveal that follows streaming append.
/// The trailing edge fades wider than the leading one so new glyphs softly
/// appear; the full text is shown (never truncated to an ellipsis).
private struct ScrollingLine: View {
    let text: String
    var opacity: Double = 0.95
    @State private var textWidth: CGFloat = 0

    private var display: String { text.replacingOccurrences(of: "\n", with: " ") }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let fits = textWidth <= w
            // Rendered left edge of the text within the window: centered when it
            // fits, else pushed left (with a little right padding) to reveal the end.
            let x = fits ? (w - textWidth) / 2 : (w - textWidth - 14)

            Text(display)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(opacity))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .background(
                    GeometryReader { g in
                        Color.clear.preference(key: TextWidthKey.self, value: g.size.width)
                    }
                )
                .offset(x: x)
                .frame(width: w, height: geo.size.height, alignment: .leading) // .leading = vertically centered
                .clipped()
                .mask(edgeFade(width: w, fade: !fits))
                .animation(.easeOut(duration: 0.26), value: textWidth)
                .onPreferenceChange(TextWidthKey.self) { textWidth = $0 }
        }
    }

    private func edgeFade(width w: CGFloat, fade: Bool) -> some View {
        // No fade when the text fits (so short, centered text isn't dimmed at the
        // ends); soft, asymmetric fade while scrolling.
        let lf = fade ? min(0.14, 12 / max(w, 1)) : 0
        let rf = fade ? min(0.22, 26 / max(w, 1)) : 0
        return LinearGradient(
            stops: [
                .init(color: .clear, location: 0),
                .init(color: .black, location: lf),
                .init(color: .black, location: 1 - rf),
                .init(color: .clear, location: 1),
            ],
            startPoint: .leading, endPoint: .trailing
        )
    }
}

private struct TextWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// A bright band that travels left → right as `phase` goes 0 → 1. Used as a
/// `.mask` (reveal a bright layer) or directly as a sweeping highlight.
private struct SweepBand: View {
    let phase: CGFloat

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let bandW = max(36, w * 0.5)
            LinearGradient(
                colors: [.clear, .white, .white, .clear],
                startPoint: .leading, endPoint: .trailing
            )
            .frame(width: bandW)
            .offset(x: -bandW + phase * (w + bandW))
        }
    }
}

/// A soft light sweeping across the whole capsule (扫光) while thinking.
private struct CapsuleSweep: View {
    @State private var phase: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let bandW = w * 0.42
            LinearGradient(
                colors: [.clear, .white.opacity(0.14), .clear],
                startPoint: .leading, endPoint: .trailing
            )
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

/// A glowing arc that rotates around the capsule's edge (胶囊形边缘光波) — the
/// "AI is thinking" cue. A blurred layer underneath gives it bloom.
private struct CapsuleEdgeGlow: View {
    @State private var angle: Double = 0
    private let accent = Color(red: 0.42, green: 0.78, blue: 1.0)

    var body: some View {
        let gradient = AngularGradient(
            gradient: Gradient(stops: [
                .init(color: .clear, location: 0.0),
                .init(color: .clear, location: 0.58),
                .init(color: accent.opacity(0.65), location: 0.80),
                .init(color: .white, location: 0.88),
                .init(color: accent.opacity(0.65), location: 0.96),
                .init(color: .clear, location: 1.0),
            ]),
            center: .center,
            angle: .degrees(angle)
        )
        ZStack {
            Capsule(style: .continuous)
                .strokeBorder(gradient, lineWidth: 2.6)
                .blur(radius: 2.6)
            Capsule(style: .continuous)
                .strokeBorder(gradient, lineWidth: 1.2)
        }
        .allowsHitTesting(false)
        .onAppear {
            angle = 0
            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) {
                angle = 360
            }
        }
    }
}

// MARK: - Done: brief confirmation

private struct DoneContent: View {
    let text: String

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color(red: 0.36, green: 0.85, blue: 0.52))
            if !text.isEmpty {
                ScrollingLine(text: text)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: 24)
        .padding(.horizontal, 2)
    }
}

// MARK: - Notice (errors / busy)

private struct NoticeView: View {
    @ObservedObject var state: NoticeState
    @State private var copied = false

    private var isCopy: Bool { state.mode == .copy }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: isCopy ? "doc.on.clipboard" : "exclamationmark.circle")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(isCopy
                        ? Color(red: 0.38, green: 0.62, blue: 0.98)
                        : Color(red: 0.96, green: 0.48, blue: 0.18))

                Text(state.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                Spacer(minLength: 6)

                Button(action: { state.onClose?() }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.58))
                        .frame(width: 18, height: 18)
                }
                .buttonStyle(.plain)
            }

            Text(state.message)
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(.white.opacity(0.76))
                .lineLimit(isCopy ? 4 : 2)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            if !state.hint.isEmpty {
                Text(state.hint)
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Spacer()

                if !state.authorizeTitle.isEmpty {
                    Button(action: { state.onAuthorize?() }) {
                        Text(state.authorizeTitle)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .frame(height: 31)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(Color(red: 0.38, green: 0.62, blue: 0.98))
                            )
                    }
                    .buttonStyle(.plain)
                }

                Button(action: primaryAction) {
                    Group {
                        if isCopy {
                            Label(buttonTitle, systemImage: copied ? "checkmark" : "doc.on.doc")
                                .labelStyle(.titleAndIcon)
                        } else {
                            Text(buttonTitle)
                        }
                    }
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(height: 31)
                    .background(
                        Capsule(style: .continuous)
                            .fill(Color.white.opacity(copied ? 0.18 : 0.25))
                    )
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(.top, 2)
        }
        .padding(.top, 16)
        .padding(.horizontal, 18)
        .padding(.bottom, 15)
        .frame(width: 304)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(red: 0.075, green: 0.07, blue: 0.07))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(.white.opacity(0.08))
                )
        )
        .shadow(color: .black.opacity(0.40), radius: 20, x: 0, y: 9)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var buttonTitle: String {
        if isCopy { return copied ? "已复制" : state.actionTitle }
        return state.actionTitle
    }

    private func primaryAction() {
        if isCopy {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(state.copyText, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { copied = false }
        } else {
            state.onAction?()
        }
    }
}

// MARK: - Unified dictation deck (recording + concurrent results)

/// The single floating layer at the bottom edge. Its front (bottom) card is the
/// current activity — the live recording capsule while recording, otherwise the
/// newest conversion — and earlier conversions stack behind it in one deck.
/// Shown while recording or while any job is in the deck.
@MainActor
final class DictationStackController {
    private let queue: DictationQueue
    private let recording: RecordingState
    private var panel: NSPanel?
    private var c1: AnyCancellable?
    private var c2: AnyCancellable?
    private var isShown = false
    private let size = NSSize(width: 400, height: 460)

    init(queue: DictationQueue, recording: RecordingState) {
        self.queue = queue
        self.recording = recording
        c1 = queue.objectWillChange.sink { [weak self] in
            DispatchQueue.main.async { self?.sync() }
        }
        c2 = recording.objectWillChange.sink { [weak self] in
            DispatchQueue.main.async { self?.sync() }
        }
    }

    private func sync() {
        let want = recording.active || !queue.cards.isEmpty
        if want, !isShown { show(); isShown = true }
        else if !want, isShown { hide(); isShown = false }
    }

    private func build() {
        let hosting = NSHostingView(rootView: DictationStackView(queue: queue, recording: recording))
        hosting.wantsLayer = true
        hosting.layer?.backgroundColor = .clear
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.acceptsMouseMovedEvents = true   // so the deck's hover-to-expand fires
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.contentView = hosting
        self.panel = panel
    }

    private func show() {
        if panel == nil { build() }
        if let panel, let screen = NSScreen.main {
            let v = screen.visibleFrame
            // Anchor the panel's bottom at the screen edge; the deck inside is
            // bottom-aligned so the front card hugs the bottom (tiny breathing gap).
            panel.setFrameOrigin(NSPoint(x: v.midX - size.width / 2, y: v.minY))
        }
        panel?.orderFrontRegardless()
    }

    private func hide() { panel?.orderOut(nil) }
}

/// A bottom-anchored deck. The front (bottom) layer is the current activity — the
/// live recording capsule while recording, else the newest conversion — fixed at
/// the bottom edge. Earlier conversions stack behind it, each progressively
/// smaller, nudged up and dimmer. Hovering fans the deck open into a full list with
/// a staggered spring; leaving collapses it. The front slot never moves: a new
/// recording just pushes the previous conversion into the deck behind it.
struct DictationStackView: View {
    @ObservedObject var queue: DictationQueue
    @ObservedObject var recording: RecordingState
    @State private var expanded = false

    private let maxVisible = 8         // how many cards the deck holds at once
    private let cardH: CGFloat = 42
    private let peek: CGFloat = 11     // collapsed: how far each deeper card pokes up
    private let gap: CGFloat = 8       // expanded: spacing between cards

    private enum Layer: Identifiable {
        case recording
        case job(DictationJob)
        var id: String {
            switch self {
            case .recording:       return "recording"
            case .job(let job):    return job.id.uuidString
            }
        }
    }

    /// Front (index 0) → back. Recording, if active, is always the front layer;
    /// then conversions newest → oldest.
    private var layers: [Layer] {
        var result: [Layer] = []
        if recording.active { result.append(.recording) }
        for job in queue.cards.reversed() { result.append(.job(job)) }
        return Array(result.prefix(maxVisible))
    }

    private struct DeckKey: Equatable { let expanded: Bool; let ids: [String] }

    var body: some View {
        // Folded and expanded render the SAME set of cards — hover only changes the
        // layout (peeking shells ↔ a fanned-open list), so no card ever pops in or
        // out as the deck opens. Deeper folded cards draw as clean shells.
        let items = layers
        let n = items.count

        ZStack(alignment: .bottom) {
            ForEach(Array(items.enumerated()), id: \.element.id) { depth, layer in
                // Only the front card (or every card, once expanded) shows its
                // content; deeper collapsed cards render as clean capsule shells so
                // their text/buttons don't bleed through the 12pt peek and overlap.
                layerView(layer, revealed: expanded || depth == 0)
                    .scaleEffect(scale(depth), anchor: .bottom)
                    .offset(y: yOffset(depth))
                    .opacity(opacity(depth))
                    .zIndex(Double(n - depth))
                    .allowsHitTesting(expanded || depth == 0)
                    .transition(.opacity)
                    .animation(
                        .spring(response: 0.42, dampingFraction: 0.82)
                            .delay(expanded ? Double(depth) * 0.035 : 0),
                        value: DeckKey(expanded: expanded, ids: items.map(\.id))
                    )
            }
        }
        .frame(width: 300, height: stackHeight(n), alignment: .bottom)
        .onHover { hovering in expanded = hovering }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 8)
    }

    @ViewBuilder private func layerView(_ layer: Layer, revealed: Bool) -> some View {
        switch layer {
        case .recording:
            RecordingCard(recording: recording)
        case .job(let job):
            JobCard(
                job: job,
                revealed: revealed,
                onCopy: { queue.copy(job) },
                onInsert: { queue.manualInsert(job) },
                onDismiss: { queue.dismiss(job) }
            )
        }
    }

    private func scale(_ depth: Int) -> CGFloat {
        // Every card behind keeps shrinking (no flat clamp), so the deck recedes
        // smoothly instead of showing equal-size cards stacked with an offset.
        expanded ? 1 : max(0.42, 1 - CGFloat(depth) * 0.08)
    }
    private func yOffset(_ depth: Int) -> CGFloat {
        expanded ? -CGFloat(depth) * (cardH + gap) : -CGFloat(depth) * peek
    }
    private func opacity(_ depth: Int) -> Double {
        if depth == 0 { return 1 }
        // Deeper cards fade as they recede, so a tall stack tapers off gently.
        return expanded ? 1 : max(0.12, 1 - Double(depth) * 0.15)
    }
    private func stackHeight(_ n: Int) -> CGFloat {
        guard n > 0 else { return cardH }
        return expanded
            ? CGFloat(n) * cardH + CGFloat(n - 1) * gap
            : cardH + CGFloat(n - 1) * peek
    }
}

// MARK: - Recording card (front of the deck while recording)

private struct RecordingCard: View {
    @ObservedObject var recording: RecordingState

    var body: some View {
        HStack(spacing: 8) {
            circleButton("xmark", filled: false) { recording.onCancel?() }
            RecordingLevelBars(level: recording.level)
                .frame(maxWidth: .infinity)   // fills the full-width capsule
            circleButton("checkmark", filled: true) { recording.onCommit?() }
        }
        .padding(.horizontal, 12)
        .frame(width: 250, height: 42)        // match the conversion cards so the deck is uniform
        .background(
            ZStack {
                Capsule(style: .continuous).fill(Color.black.opacity(0.9))
                Capsule(style: .continuous).strokeBorder(.white.opacity(0.09))
            }
        )
        .shadow(color: .black.opacity(0.34), radius: 14, x: 0, y: 6)
    }

    private func circleButton(_ system: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(filled ? .black.opacity(0.88) : .white.opacity(0.9))
                .frame(width: 26, height: 26)
                .background(Circle().fill(filled ? Color.white.opacity(0.94) : Color.white.opacity(0.18)))
        }
        .buttonStyle(.plain)
    }
}

/// A live, Siri-style equalizer filling the capsule width: a centered row of
/// rounded bars. One amplitude — the real smoothed mic loudness (`level.value`) —
/// scales the whole row, a bell envelope makes the center tallest and the edges
/// shorter, and each bar bounces on its own irregular rhythm so the row jitters
/// like a real level meter rather than a single coordinated wave. So:
///   • silence → every bar rests at a dot, a still grey dotted line;
///   • quiet speech → a low soft bounce; loud speech → a tall one.
/// Colour tracks loudness: grey when quiet, brightening toward white as you get
/// louder, with a faint amplitude-gated shimmer (闪烁). Every animated term is
/// multiplied by amplitude, so a silent room shows no motion at all.
///
/// A run-loop `Timer` drives the dance/shimmer — `TimelineView(.animation)`'s
/// display-link schedule doesn't tick inside this non-key floating `NSPanel`.
private struct RecordingLevelBars: View {
    @ObservedObject var level: RecordingLevel
    @State private var phase: Double = 0
    @State private var timer: Timer?
    private let barWidth: CGFloat = 3
    private let barStep: CGFloat = 6      // bar width + gap → density across the fill

    var body: some View {
        Canvas { ctx, size in
            drawBars(in: &ctx, size: size, amp: Double(level.value), phase: phase)
        }
        .frame(height: 24)
        .onAppear(perform: startTicking)
        .onDisappear { timer?.invalidate(); timer = nil }
    }

    private func startTicking() {
        timer?.invalidate()
        let t = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in
            phase += 1.0 / 60.0
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    /// Kept out of `body` with every value pinned to `Double` — inline, the mixed
    /// CGFloat/Double arithmetic in the `sin` terms blows up SwiftUI's type-checker
    /// on newer Swift toolchains ("unable to type-check in reasonable time").
    private func drawBars(in ctx: inout GraphicsContext, size: CGSize, amp rawAmp: Double, phase: Double) {
        let w = Double(size.width)
        let h = Double(size.height)
        var count = max(3, Int(w / Double(barStep)))
        if count % 2 == 0 { count -= 1 }             // odd → a true center bar
        let mid = Double((count - 1) / 2)
        let midY = h / 2
        let dot = 2.5                                 // edge / idle dot height
        let maxBar = h - 1                            // center height at full volume
        let amp = min(1, max(0, rawAmp))

        // Grey → white with loudness; a faint amp-gated shimmer so loud speech
        // sparkles while silence stays a steady grey.
        let shimmer = 1.0 + amp * (0.08 * sin(phase * 13) + 0.05 * sin(phase * 29))
        let whiteness = 0.45 + 0.55 * amp
        let color = Color(white: min(1, max(0, whiteness * shimmer)), opacity: 0.95)

        for i in 0..<count {
            let dist = abs(Double(i) - mid) / max(1, mid)   // 0 center … 1 edge
            let bell = 0.4 + 0.6 * cos(dist * .pi / 2)      // taller center, shorter edges
            // Each bar bounces on its OWN irregular rhythm: two incommensurate sines
            // with per-bar phase seeds → the row jitters independently (like a real
            // level meter) instead of moving as one coordinated wave. Gated by amp,
            // so silence is perfectly still.
            let n = 0.55 * sin(phase * 9.0 + Double(i) * 1.73)
                  + 0.45 * sin(phase * 15.3 + Double(i) * 2.39)
            let jitter = 0.10 + 0.90 * (0.5 + 0.5 * n)      // 0.10 … 1.0, irregular
            let barH = max(dot, dot + amp * (maxBar - dot) * bell * jitter)
            let x = w * (Double(i) + 0.5) / Double(count)
            let rect = CGRect(x: CGFloat(x) - barWidth / 2,
                              y: CGFloat(midY - barH / 2),
                              width: barWidth,
                              height: CGFloat(barH))
            ctx.fill(Capsule().path(in: rect), with: .color(color))
        }
    }
}

private struct JobCard: View {
    @ObservedObject var job: DictationJob
    /// When false (a collapsed back card), only the capsule shell is drawn — the
    /// text and buttons are hidden so the resting deck reads as a clean stack.
    var revealed: Bool = true
    let onCopy: () -> Void
    let onInsert: () -> Void
    let onDismiss: () -> Void

    @State private var copied = false

    private var processing: Bool { job.phase == .transcribing || job.phase == .polishing }

    var body: some View {
        HStack(spacing: 8) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            trailing
        }
        .opacity(revealed ? 1 : 0)        // back shells: shape only, no content
        .padding(.horizontal, 12)
        .frame(width: 250, height: 42)
        .background(background)
        .shadow(color: .black.opacity(0.34), radius: 14, x: 0, y: 6)
    }

    @ViewBuilder private var content: some View {
        switch job.phase {
        case .transcribing:
            ThinkingLabel(text: job.statusLabel)
        case .polishing:
            if job.streamText.isEmpty {
                ThinkingLabel(text: job.statusLabel)
            } else {
                StreamingText(target: job.streamText)
            }
        case .done:
            HStack(spacing: 6) {
                if job.inserted {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color(red: 0.36, green: 0.85, blue: 0.52))
                }
                ScrollingLine(text: job.result)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .failed:
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(red: 0.96, green: 0.62, blue: 0.20))
                ScrollingLine(text: job.failure ?? "出错", opacity: 0.8)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        switch job.phase {
        case .done where job.queued && !job.inserted:
            HStack(spacing: 6) {
                miniButton(copied ? "checkmark" : "doc.on.doc") {
                    onCopy()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
                }
                miniButton("arrow.down.to.line", action: onInsert)
                miniButton("xmark", action: onDismiss)
            }
        case .failed:
            miniButton("xmark", action: onDismiss)
        default:
            EmptyView()
        }
    }

    private func miniButton(_ system: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.92))
                .frame(width: 24, height: 24)
                .background(Circle().fill(Color.white.opacity(0.14)))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var background: some View {
        ZStack {
            Capsule(style: .continuous).fill(Color.black.opacity(0.9))
            // The thinking sweep / edge glow only animate on a revealed card, so a
            // collapsed back shell stays calm instead of pulsing behind the front.
            if processing && revealed {
                CapsuleSweep().clipShape(Capsule(style: .continuous))
            }
            Capsule(style: .continuous).strokeBorder(.white.opacity(0.09))
            if processing && revealed {
                CapsuleEdgeGlow()
            }
        }
    }
}
