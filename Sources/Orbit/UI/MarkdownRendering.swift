//  MarkdownRendering.swift
//  Renders assistant replies with MarkdownUI (mainstream SwiftUI Markdown: code
//  blocks, tables, lists, GFM). Code blocks get a header (language + copy) and a
//  bordered, scrollable body.
//
//  Syntax coloring is done by our own `SyntaxHighlighter` (pure Swift, no resource
//  bundle) — NOT Highlightr. Highlightr loads highlight.js via SwiftPM's generated
//  `Bundle.module` accessor, which resolves resources at the .app ROOT or a
//  hardcoded build path — neither exists in a signed/notarized .app assembled by
//  build.sh, so `Highlightr()` fatal-errored at runtime (crashed 0.0.6 on the
//  first chat code block). The local tokenizer can't crash on a missing resource.

import SwiftUI
import AppKit
import MarkdownUI

/// A chat Markdown block with bordered, copyable, syntax-coloured code blocks.
struct ChatMarkdown: View {
    let content: String

    var body: some View {
        Markdown(content)
            .markdownCodeSyntaxHighlighter(.orbit)
            .markdownBlockStyle(\.codeBlock) { configuration in
                CodeBlock(configuration: configuration)
            }
            .textSelection(.enabled)
    }
}

/// Bridges our `SyntaxHighlighter` to MarkdownUI's code-block rendering.
struct OrbitCodeHighlighter: CodeSyntaxHighlighter {
    func highlightCode(_ code: String, language: String?) -> Text {
        Text(SyntaxHighlighter.highlight(code, language: language))
    }
}

extension CodeSyntaxHighlighter where Self == OrbitCodeHighlighter {
    static var orbit: OrbitCodeHighlighter { OrbitCodeHighlighter() }
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
                    .font(.system(.callout, design: .monospaced))
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
