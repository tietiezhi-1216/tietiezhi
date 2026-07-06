//  MarkdownRendering.swift
//  Renders assistant replies with MarkdownUI (mainstream SwiftUI Markdown: code
//  blocks, tables, lists, GFM) and highlights code blocks with Highlightr
//  (highlight.js — 180+ languages). The Highlightr theme follows light/dark.

import SwiftUI
import AppKit
import MarkdownUI
import Highlightr

/// A chat Markdown block with syntax-highlighted, bordered, copyable code blocks.
struct ChatMarkdown: View {
    let content: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Markdown(content)
            .markdownCodeSyntaxHighlighter(.highlightr(dark: colorScheme == .dark))
            .markdownBlockStyle(\.codeBlock) { configuration in
                CodeBlock(configuration: configuration)
            }
            .textSelection(.enabled)
    }
}

/// A code block with a header (language + copy button) and a bordered, scrollable
/// body — the pattern users expect from other apps.
private struct CodeBlock: View {
    let configuration: CodeBlockConfiguration
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text((configuration.language?.isEmpty == false ? configuration.language! : "code"))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: copy) {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                        .foregroundStyle(copied ? Color.green : Color.secondary)
                }
                .buttonStyle(.plain)
                .help("复制代码")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            Divider()

            ScrollView(.horizontal, showsIndicators: false) {
                configuration.label
                    .padding(10)
            }
        }
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.quaternary))
        .padding(.top, 2)      // back to the original small top margin
        .padding(.bottom, 12)  // clear gap below, so it isn't glued to the next text
    }

    private func copy() {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(configuration.content, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

// MARK: - Highlightr → MarkdownUI adapter

struct HighlightrSyntaxHighlighter: CodeSyntaxHighlighter {
    let theme: String

    // Highlightr loads highlight.js through JavaScriptCore, so instances are
    // reused per theme rather than rebuilt on every code block.
    private static var cache: [String: Highlightr] = [:]

    private func highlighter() -> Highlightr? {
        if let existing = Self.cache[theme] { return existing }
        let created = Highlightr()
        created?.setTheme(to: theme)
        Self.cache[theme] = created
        return created
    }

    func highlightCode(_ code: String, language: String?) -> Text {
        guard let hl = highlighter(),
              let attributed = hl.highlight(code, as: normalize(language), fastRender: true)
        else { return Text(code) }
        return Text(AttributedString(attributed))
    }

    /// highlight.js uses lowercase language ids; nil lets it auto-detect.
    private func normalize(_ language: String?) -> String? {
        guard let l = language?.trimmingCharacters(in: .whitespaces).lowercased(), !l.isEmpty else { return nil }
        return l
    }
}

extension CodeSyntaxHighlighter where Self == HighlightrSyntaxHighlighter {
    static func highlightr(dark: Bool) -> Self {
        HighlightrSyntaxHighlighter(theme: dark ? "atom-one-dark" : "atom-one-light")
    }
}
