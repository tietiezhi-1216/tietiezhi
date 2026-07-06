//  ChatComposerField.swift
//  An AppKit-backed multiline chat input. SwiftUI's TextField + onKeyPress can't
//  tell an IME "confirm composition" Return from a real newline/submit Return, so
//  pressing Return to pick a Chinese candidate wrongly sent the message. An
//  NSTextView handles this correctly: while composing (marked text present) the
//  Return goes to `insertText:` to commit the candidate and never reaches
//  `insertNewline:`, so we only submit on a Return that actually inserts a newline.
//
//  Also handles pasting images / files directly (⌘V) and auto-grows its height.

import SwiftUI
import AppKit

struct ChatComposerField: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    let minHeight: CGFloat
    let maxHeight: CGFloat
    var onSubmit: () -> Void
    var onAttach: ([URL]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ComposerTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.font = .systemFont(ofSize: NSFont.systemFontSize)
        textView.textColor = .labelColor
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 2, height: 6)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.allowsUndo = true
        textView.onAttach = { urls in
            DispatchQueue.main.async { context.coordinator.parent.onAttach(urls) }
        }

        let scroll = NSScrollView()
        scroll.documentView = textView
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.verticalScrollElasticity = .none
        scroll.autohidesScrollers = true
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? ComposerTextView else { return }
        context.coordinator.parent = self
        if tv.string != text { tv.string = text }
        context.coordinator.recalculate(tv)
    }

    /// Persist a pasted image so its file path survives (attachments are URLs).
    static func saveImage(_ image: NSImage) -> URL? {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let dir = SettingsStore.configDirectory().appendingPathComponent("attachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("paste-\(UUID().uuidString).png")
        try? png.write(to: url)
        return url
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatComposerField
        init(_ parent: ChatComposerField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
            recalculate(tv)
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            // `insertNewline:` only fires for a Return that isn't confirming an IME
            // composition — exactly when we should send (unless Shift = newline).
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { return false }
                parent.onSubmit()
                return true
            }
            return false
        }

        func recalculate(_ tv: NSTextView) {
            guard let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let used = lm.usedRect(for: tc).height + tv.textContainerInset.height * 2
            let clamped = min(max(used, parent.minHeight), parent.maxHeight)
            if abs(parent.height - clamped) > 0.5 {
                DispatchQueue.main.async { self.parent.height = clamped }
            }
        }
    }
}

/// NSTextView that redirects pasted images / files to the composer's attachments.
final class ComposerTextView: NSTextView {
    var onAttach: (([URL]) -> Void)?

    override func paste(_ sender: Any?) {
        if attach(from: NSPasteboard.general) { return }
        super.paste(sender)
    }

    private func attach(from pb: NSPasteboard) -> Bool {
        var urls: [URL] = []
        if let fileURLs = pb.readObjects(forClasses: [NSURL.self],
                                         options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            urls.append(contentsOf: fileURLs)
        }
        if urls.isEmpty, let images = pb.readObjects(forClasses: [NSImage.self]) as? [NSImage] {
            for image in images { if let url = ChatComposerField.saveImage(image) { urls.append(url) } }
        }
        guard !urls.isEmpty else { return false }
        onAttach?(urls)
        return true
    }
}
