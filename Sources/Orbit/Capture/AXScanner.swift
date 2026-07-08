//  AXScanner.swift
//  Accessibility (AX) bridge for element-level capture: read the UI node tree of
//  the app under the cursor so the selection can snap to a control (not just a
//  whole window), and so the AI annotator gets precise, labelled element anchors
//  instead of guessing pixel coordinates off a grid.
//
//  Key trick: hit-test against the TARGET APP's element (AXUIElementCreateApplication
//  + AXUIElementCopyElementAtPosition on it), never the system-wide element. The
//  app hit-tests inside its own subtree by screen position, so our capture overlay
//  — which sits on top at screenSaver level — is invisible to the query.
//
//  Coordinates: AX position/size are in CG-GLOBAL space (origin at the primary
//  display's top-left, y down) — the same space CGWindowList uses — so the
//  view-coordinate conversion mirrors ScreenCapturer.snapWindows exactly.

import AppKit
import ApplicationServices

/// One meaningful UI element. `frame` is CG-global (top-left) as returned by AX;
/// callers convert to overlay-view coordinates with `AXScanner.axRectToView`.
struct AXNode {
    let role: String        // e.g. "AXButton", "AXTextField"
    let label: String       // title / description / value, trimmed (may be "")
    let frame: CGRect
}

enum AXScanner {

    /// AX calls only work once the Accessibility permission is granted (the same
    /// grant dictation already needs for its hotkey + paste).
    static var isAvailable: Bool { AXIsProcessTrusted() }

    /// Prompt for the Accessibility grant (also registers Orbit in the list so the
    /// user can toggle it). Returns the current trust state. The literal key avoids
    /// churn in how `kAXTrustedCheckOptionPrompt` imports across SDKs.
    @discardableResult
    static func requestPermission() -> Bool {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Height of the primary display — the flip anchor between Cocoa (bottom-left)
    /// and CG-global / AX (top-left). The primary is the NSScreen at origin (0,0).
    static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    // MARK: Coordinate conversion (CG-global top-left ↔ overlay view)

    static func axRectToView(_ r: CGRect, screenFrame: CGRect) -> CGRect {
        CGRect(x: r.minX - screenFrame.minX,
               y: r.minY + screenFrame.maxY - primaryHeight,
               width: r.width, height: r.height)
    }

    static func viewPointToAX(_ p: CGPoint, screenFrame: CGRect) -> CGPoint {
        CGPoint(x: p.x + screenFrame.minX, y: p.y - screenFrame.maxY + primaryHeight)
    }

    static func viewRectToAX(_ r: CGRect, screenFrame: CGRect) -> CGRect {
        CGRect(x: r.minX + screenFrame.minX,
               y: r.minY - screenFrame.maxY + primaryHeight,
               width: r.width, height: r.height)
    }

    // MARK: Element snapping (single hit-test at a point)

    /// App root element, with Electron/Chromium accessibility switched on —
    /// those apps build their AX tree lazily and expose only a bare AXScrollArea
    /// until a client sets AXManualAccessibility (Electron) or
    /// AXEnhancedUserInterface (Chromium/VoiceOver flag). Native apps ignore both.
    private static func appElement(_ pid: pid_t) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        return app
    }

    /// Fire the Electron/Chromium accessibility wake for every candidate app AS
    /// SOON AS capture starts — their trees build asynchronously over ~a second,
    /// so waking them on first hover is too late (queries return shallow
    /// containers). One tickle per app: set the wake flags and touch the window
    /// list to nudge the tree build. Runs entirely off the main thread.
    static func prewarm(pids: [pid_t]) {
        guard AXIsProcessTrusted() else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            for pid in pids {
                let app = appElement(pid)
                AXUIElementSetMessagingTimeout(app, 0.3)
                _ = attribute(app, kAXWindowsAttribute)
            }
        }
    }

    /// Outcome of a snap query against one candidate app.
    enum SnapResult {
        case element(frame: CGRect, role: String)  // fine-grained element found
        case windowOnly                            // app owns a window here, nothing finer
        case noWindow                              // app has no window at p (wrong candidate)
    }

    /// Find the finest UI element at `p` (CG-global) in app `pid`.
    ///
    /// Two paths, verified against real apps:
    /// - Native/Electron: `CopyElementAtPosition` then DESCEND — the raw hit often
    ///   stops at a container (AXScrollArea/AXGroup); descending picks the smallest
    ///   child containing `p` at each level. (Electron additionally needs the
    ///   AXManualAccessibility wake in `appElement`, and builds its tree async —
    ///   first queries stay shallow, the hover stream converges within ~1s.)
    /// - Broken hit-test (WeChat returns its MENU BAR for in-window points): find
    ///   the app's AXWindow containing `p` and descend from the window instead.
    static func snapTarget(pid: pid_t, atGlobalPoint p: CGPoint) -> SnapResult {
        guard AXIsProcessTrusted() else { return .noWindow }
        let app = appElement(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)

        // Path 1: hit-test + descend. Trust it only if the result contains p.
        var hit: AXUIElement?
        if AXUIElementCopyElementAtPosition(app, Float(p.x), Float(p.y), &hit) == .success,
           let h = hit {
            let el = descend(from: h, at: p)
            if let f = frameOf(el), f.contains(p), f.width > 4, f.height > 4,
               (attribute(el, kAXRoleAttribute) as? String) != kAXWindowRole {
                return .element(frame: f, role: (attribute(el, kAXRoleAttribute) as? String) ?? "?")
            }
        }

        // Path 2: descend from the AXWindow under p (hit-test was garbage).
        guard let wins = attribute(app, kAXWindowsAttribute) as? [AXUIElement],
              let win = wins.first(where: { frameOf($0)?.contains(p) == true }),
              let winFrame = frameOf(win) else { return .noWindow }
        let el = descend(from: win, at: p)
        if let f = frameOf(el), f.contains(p), f.width > 4, f.height > 4,
           f.width < winFrame.width * 0.98 || f.height < winFrame.height * 0.98 {
            return .element(frame: f, role: (attribute(el, kAXRoleAttribute) as? String) ?? "?")
        }
        return .windowOnly
    }

    /// Find the finest element at `p` under `root`: the smallest-area node whose
    /// frame contains `p`. Crucially it descends THROUGH frameless / degenerate
    /// intermediate nodes (rife in web/Electron trees) instead of stopping at them.
    ///
    /// The old greedy "step into the smallest framed child each level" halted the
    /// moment a level's children were all frameless containers — leaving the result
    /// stuck on the last cleanly-framed box (a whole row), never reaching the fine
    /// controls nested a frameless group deeper. This does a bounded DFS: a child
    /// with a sane frame that excludes `p` is pruned; a child with no usable frame
    /// is still traversed so its laid-out descendants stay reachable.
    private static func descend(from root: AXUIElement, at p: CGPoint) -> AXUIElement {
        var best: (el: AXUIElement, area: CGFloat)?
        var visited = 0

        func walk(_ el: AXUIElement, depth: Int) {
            if visited > 6000 || depth > 40 { return }
            visited += 1
            let f = frameOf(el)
            // Prune only on a *sane* frame that clearly excludes p; frameless or
            // degenerate nodes fall through so we can reach their real children.
            if let f, f.width > 1, f.height > 1, !f.contains(p) { return }
            if let f, f.width > 3, f.height > 3, f.contains(p) {
                let area = f.width * f.height
                if best == nil || area < best!.area { best = (el, area) }
            }
            guard let kids = children(of: el) else { return }
            for k in kids.prefix(256) { walk(k, depth: depth + 1) }
        }

        walk(root, depth: 0)
        return best?.el ?? root
    }

    // MARK: Snap cache scan (all framed elements, PixPin-style)

    /// The snap cache: EVERY sanely-framed element in the app's AX windows, plus
    /// the window frames themselves. Unlike `nodes(pid:inGlobalRect:)` (labelled
    /// anchors for the AI), snapping needs geometry, not meaning — no role/label
    /// filter, labels never fetched (halves the IPC). Hovering then becomes a
    /// local smallest-containing-rect lookup instead of a per-point IPC hit-test,
    /// which is what makes fine-grained snapping dense AND instant. CG-global.
    static func snapScan(pid: pid_t, maxNodes: Int = 900) -> (windows: [CGRect], nodes: [AXNode]) {
        guard AXIsProcessTrusted() else { return ([], []) }
        let app = appElement(pid)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let wins = attribute(app, kAXWindowsAttribute) as? [AXUIElement], !wins.isEmpty else {
            return ([], [])
        }
        var windowFrames: [CGRect] = []
        var out: [AXNode] = []
        var visited = 0

        func walk(_ el: AXUIElement, depth: Int, window: CGRect) {
            if out.count >= maxNodes || visited > 15000 || depth > 48 { return }
            visited += 1
            let f = frameOf(el)
            // Sane frame clearly outside the window → prune; degenerate → traverse.
            if let f, f.width > 1, f.height > 1, !f.intersects(window) { return }
            if let f, f.width > 3, f.height > 3, depth > 0,
               f.width < window.width * 0.9 || f.height < window.height * 0.9 {
                out.append(AXNode(role: (attribute(el, kAXRoleAttribute) as? String) ?? "",
                                  label: "", frame: f))
            }
            guard let kids = children(of: el) else { return }
            for k in kids.prefix(512) { walk(k, depth: depth + 1, window: window) }
        }

        for w in wins {
            guard let wf = frameOf(w), wf.width > 40, wf.height > 40 else { continue }
            windowFrames.append(wf)
            walk(w, depth: 0, window: wf)
        }
        return (windowFrames, out)
    }

    // MARK: Node tree (region scan for AI anchors)

    /// Meaningful, labelled UI nodes whose frame intersects `rect` (CG-global) in
    /// app `pid`. Bounded by node/visit/depth budgets so a huge tree can't hang the
    /// background scan. Frames are CG-global (top-left).
    static func nodes(pid: pid_t, inGlobalRect rect: CGRect, maxNodes: Int = 64) -> [AXNode] {
        guard AXIsProcessTrusted() else { return [] }
        let app = appElement(pid)
        AXUIElementSetMessagingTimeout(app, 0.4)

        var out: [AXNode] = []
        var visited = 0

        func walk(_ el: AXUIElement, depth: Int) {
            if out.count >= maxNodes || visited > 8000 || depth > 48 { return }
            visited += 1
            let f = frameOf(el)
            // Prune subtrees clearly outside the selection — but only on a sane
            // frame: web/Electron containers sometimes report degenerate frames
            // while their CHILDREN are laid out fine (pruning those loses whole
            // pages of nodes — the "0 个节点" bug).
            if let f, f.width > 1, f.height > 1, !f.intersects(rect) { return }
            if let f, let node = node(from: el, frame: f, region: rect) { out.append(node) }
            if let kids = children(of: el) {
                for c in kids { walk(c, depth: depth + 1) }
            }
        }

        if let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty {
            for w in windows { walk(w, depth: 0) }
        } else {
            walk(app, depth: 0)
        }
        return out
    }

    // MARK: - AX plumbing

    private static let interestingRoles: Set<String> = [
        "AXButton", "AXTextField", "AXTextArea", "AXStaticText", "AXCheckBox",
        "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXMenuButton", "AXLink",
        "AXImage", "AXCell", "AXTabButton", "AXSlider", "AXComboBox",
        "AXSearchField", "AXDisclosureTriangle", "AXSegmentedControl", "AXToolbarButton",
        "AXIncrementor", "AXStepper", "AXSwitch",
    ]

    private static func node(from el: AXUIElement, frame: CGRect, region: CGRect) -> AXNode? {
        // Drop near-window-sized containers — they're not useful anchors.
        if frame.width >= region.width * 0.97, frame.height >= region.height * 0.97 { return nil }
        let role = (attribute(el, kAXRoleAttribute) as? String) ?? ""
        let label = bestLabel(el)
        guard interestingRoles.contains(role) || !label.isEmpty else { return nil }
        return AXNode(role: role, label: label, frame: frame)
    }

    private static func frameOf(_ el: AXUIElement) -> CGRect? {
        guard let posV = axValue(el, kAXPositionAttribute),
              let sizeV = axValue(el, kAXSizeAttribute) else { return nil }
        var pos = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(posV, .cgPoint, &pos), AXValueGetValue(sizeV, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }

    private static func bestLabel(_ el: AXUIElement) -> String {
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
            if let s = attribute(el, attr) as? String {
                let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { return String(t.prefix(64)) }
            }
        }
        // Some controls carry their label in a linked title element.
        if let raw = attribute(el, "AXTitleUIElement"), CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let titleEl = raw as! AXUIElement
            if let s = attribute(titleEl, kAXValueAttribute) as? String {
                return String(s.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
            }
        }
        return ""
    }

    private static func children(of el: AXUIElement) -> [AXUIElement]? {
        attribute(el, kAXChildrenAttribute) as? [AXUIElement]
    }

    private static func attribute(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success ? value : nil
    }

    private static func axValue(_ el: AXUIElement, _ attr: String) -> AXValue? {
        guard let v = attribute(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        return (v as! AXValue)
    }
}

/// Hover snapper with a PixPin-style element cache. At capture start every
/// candidate app's WHOLE tree is scanned once (background); hovering is then a
/// pure-geometry "smallest rect containing the point" lookup — instant and as
/// dense as the tree itself, so small nested controls snap too. The live IPC
/// hit-test remains as a fallback while scans are still filling.
@MainActor
final class ElementSnapper {
    private let queue = DispatchQueue(label: "com.orbit.ax.snap", qos: .userInitiated)
    /// Scans run on their own queue so a slow whole-tree walk never starves the
    /// live per-point fallback queries.
    private let scanQueue = DispatchQueue(label: "com.orbit.ax.scan", qos: .userInitiated)
    private var seq = 0
    private var logged = 0   // one-shot diagnostics for the first few queries

    private struct CacheEntry {
        let windows: [CGRect]     // the app's AX window frames (CG-global)
        let nodes: [AXNode]       // every framed element, CG-global
        let finishedAt: Date
    }

    private var cache: [pid_t: CacheEntry] = [:]
    private var scanKicked: Set<pid_t> = []
    private var rescanned: Set<pid_t> = []

    /// Scan candidates' trees into the cache. Slightly delayed so the Electron
    /// wake from `AXScanner.prewarm` has landed before we walk the tree.
    func prescan(pids: [pid_t], delay: TimeInterval = 0.6) {
        for pid in pids { kickScan(pid, delay: delay) }
    }

    private func kickScan(_ pid: pid_t, delay: TimeInterval = 0) {
        guard !scanKicked.contains(pid) else { return }
        scanKicked.insert(pid)
        scanQueue.asyncAfter(deadline: .now() + delay) {
            let result = AXScanner.snapScan(pid: pid)
            DispatchQueue.main.async { [weak self] in
                self?.cache[pid] = CacheEntry(windows: result.windows, nodes: result.nodes,
                                              finishedAt: Date())
                CaptureLog.log("AX扫描 pid=\(pid)：\(result.windows.count) 窗 \(result.nodes.count) 元素")
            }
        }
    }

    /// Electron trees build asynchronously — a scan that ran too early comes back
    /// sparse. Once, after things settle, scan again.
    private func maybeRescan(_ pid: pid_t, entry: CacheEntry) {
        guard entry.nodes.count < 40, !rescanned.contains(pid),
              Date().timeIntervalSince(entry.finishedAt) > 1.2 else { return }
        rescanned.insert(pid)
        scanKicked.remove(pid)
        cache[pid] = nil
        kickScan(pid)
    }

    /// Ask for the finest element frame (overlay-view coords) at `viewPoint`,
    /// trying candidate apps front-to-back.
    ///
    /// Cache fast path (per pid): app has an AX window at the point →
    ///   smallest cached node containing the point wins; none → nil (window snap —
    ///   never descend to an app occluded behind the top one). App has NO AX
    ///   window at the point (e.g. an invisible CG helper window won the CG window
    ///   match) → try the next candidate.
    /// Slow path: live IPC hit-test, used only while a cache is still filling.
    func request(viewPoint: CGPoint, pids: [pid_t], screenFrame: CGRect,
                 completion: @escaping (CGRect?) -> Void) {
        seq += 1
        let token = seq
        let axPoint = AXScanner.viewPointToAX(viewPoint, screenFrame: screenFrame)

        var uncached: [pid_t] = []
        for pid in pids {
            guard let entry = cache[pid] else {
                uncached.append(pid)
                kickScan(pid)
                continue
            }
            maybeRescan(pid, entry: entry)
            guard entry.windows.contains(where: { $0.contains(axPoint) }) else { continue }
            let best = entry.nodes
                .filter { $0.frame.contains(axPoint) }
                .min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
            if logged < 8 {
                logged += 1
                let hit = best.map { "缓存命中 \($0.role) \($0.frame.integral)" } ?? "缓存无节点(仅窗口)"
                CaptureLog.log("AX吸附#\(logged) axPt=(\(Int(axPoint.x)),\(Int(axPoint.y))) pid=\(pid) \(hit)（缓存\(entry.nodes.count)元素）")
            }
            completion(best.map { AXScanner.axRectToView($0.frame, screenFrame: screenFrame) })
            return
        }

        // No cached app owned the point — live-query the ones we haven't scanned yet.
        guard !uncached.isEmpty else {
            completion(nil)
            return
        }
        queue.async { [weak self] in
            var viewFrame: CGRect?
            var trace = "无候选"
            search: for pid in uncached {
                switch AXScanner.snapTarget(pid: pid, atGlobalPoint: axPoint) {
                case .element(let f, let role):
                    viewFrame = AXScanner.axRectToView(f, screenFrame: screenFrame)
                    trace = "pid=\(pid) 实查命中 \(role) \(f.integral)"
                    break search
                case .windowOnly:
                    trace = "pid=\(pid) 实查仅窗口"
                    break search
                case .noWindow:
                    continue
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if self.logged < 8 {
                    self.logged += 1
                    CaptureLog.log("AX吸附#\(self.logged) axPt=(\(Int(axPoint.x)),\(Int(axPoint.y))) → \(trace)")
                }
                guard token == self.seq else { return }   // superseded → drop
                completion(viewFrame)
            }
        }
    }
}
