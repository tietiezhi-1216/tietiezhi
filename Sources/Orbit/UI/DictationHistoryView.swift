//  DictationHistoryView.swift
//  听写 › 历史: every finished dictation, newest first — so a transcript is never
//  lost once the pill disappears. Copy staged text outputs, play/export audio,
//  delete individual entries, or clean up expired retained files.

import SwiftUI
import AppKit

struct DictationHistoryView: View {
    @EnvironmentObject var history: DictationHistoryStore

    /// How many rows to render at once. `Form` renders its rows eagerly (no
    /// lazy loading), so with hundreds of retained entries showing them all at
    /// once stutters. We window the list and reveal more on demand.
    private static let pageSize = 25
    @State private var visibleCount = DictationHistoryView.pageSize

    var body: some View {
        PageScaffold(title: "听写 · 历史") {
            Form {
                Section {
                    if history.entries.isEmpty {
                        Text("还没有听写记录。每次录音结束后会立即保存完整音频；识别和润色完成后会分别保存文本，保留 7 天。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(history.entries.prefix(visibleCount))) { entry in
                            HistoryRow(
                                entry: entry,
                                onCopy: copy,
                                onDelete: { history.remove(id: entry.id) }
                            )
                        }

                        if history.entries.count > visibleCount {
                            Button {
                                visibleCount += Self.pageSize
                            } label: {
                                Label("加载更多（还有 \(history.entries.count - visibleCount) 条）",
                                      systemImage: "chevron.down")
                            }
                            .buttonStyle(.borderless).controlSize(.small)
                        }
                    }
                } header: {
                    HStack {
                        Text("近 7 天 · 共 \(history.entries.count) 条")
                        Spacer()
                        Button { history.pruneExpired() } label: {
                            Label("清理过期", systemImage: "clock.badge.xmark")
                        }
                        .buttonStyle(.borderless).controlSize(.small)

                        if !history.entries.isEmpty {
                            Button(role: .destructive) { history.clear() } label: {
                                Label("清空全部", systemImage: "trash")
                            }
                            .buttonStyle(.borderless).controlSize(.small)
                        }
                    }
                } footer: {
                    Text("音频、转写文本、润色文本都会随听写会话落盘；超过 7 天会自动清理。")
                }
            }
            .formStyle(.grouped)
        }
    }

    private func copy(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }
}

private struct HistoryRow: View {
    let entry: DictationEntry
    let onCopy: (String) -> Void
    let onDelete: () -> Void

    @State private var copiedKind: String?
    @State private var sound: NSSound?
    @State private var playing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let failure = entry.failure, entry.transcript.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(failure)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
            }

            if !entry.transcript.isEmpty {
                textBlock(title: "转写", text: entry.transcript)
            }

            if let polished = entry.polished, !polished.isEmpty {
                textBlock(title: "润色", text: polished)
            }

            HStack(spacing: 8) {
                Text(Self.dateFormatter.string(from: entry.date))
                    .font(.caption2).foregroundStyle(.secondary)

                if let label = modeLabel { badge(label) }
                if entry.inserted { badge("已输入") }
                if entry.audioURL != nil { badge("音频") }
                if !entry.transcript.isEmpty { badge("转写") }
                if entry.polished?.isEmpty == false { badge("润色") }
                Text("保留至 \(Self.expiryFormatter.string(from: entry.expiresAt))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                Spacer()
            }

            HStack(spacing: 8) {
                if !entry.transcript.isEmpty {
                    actionButton(title: copiedKind == "transcript" ? "已复制转写" : "复制转写文本",
                                 system: copiedKind == "transcript" ? "checkmark" : "doc.on.doc") {
                        copy(entry.transcript, kind: "transcript")
                    }
                }

                if let polished = entry.polished, !polished.isEmpty {
                    actionButton(title: copiedKind == "polished" ? "已复制润色" : "复制润色文本",
                                 system: copiedKind == "polished" ? "checkmark" : "sparkles") {
                        copy(polished, kind: "polished")
                    }
                }

                if entry.audioURL != nil {
                    actionButton(title: playing ? "停止试听" : "试听完整音频",
                                 system: playing ? "stop.fill" : "play.fill",
                                 action: togglePlayback)
                    actionButton(title: "导出音频", system: "square.and.arrow.down", action: exportAudio)
                }

                if entry.artifactDirectoryURL != nil {
                    actionButton(title: "显示文件", system: "folder", action: revealFiles)
                }

                Spacer()

                Button(role: .destructive, action: onDelete) {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless).controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    private func textBlock(title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.callout)
                .foregroundStyle(.primary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    /// The template name this entry was polished with; nil for transcribe-only.
    private var modeLabel: String? {
        if let m = entry.mode {
            return m == "raw" ? nil : m
        }
        return entry.polished != nil ? "润色" : nil
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(.quaternary, in: Capsule())
    }

    private func actionButton(title: String, system: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: system)
                .labelStyle(.titleAndIcon)
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
    }

    private func copy(_ text: String, kind: String) {
        onCopy(text)
        copiedKind = kind
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            if copiedKind == kind { copiedKind = nil }
        }
    }

    private func togglePlayback() {
        if playing {
            sound?.stop()
            playing = false
            return
        }
        guard let url = entry.audioURL,
              FileManager.default.fileExists(atPath: url.path),
              let player = NSSound(contentsOf: url, byReference: true)
        else { return }
        sound = player
        playing = player.play()
    }

    private func exportAudio() {
        guard let source = entry.audioURL,
              FileManager.default.fileExists(atPath: source.path)
        else { return }
        let panel = NSSavePanel()
        panel.title = "导出完整音频"
        panel.nameFieldStringValue = source.lastPathComponent
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.copyItem(at: source, to: destination)
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        } catch {
            let alert = NSAlert()
            alert.messageText = "导出失败"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    private func revealFiles() {
        guard let url = entry.artifactDirectoryURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm"
        return f
    }()

    private static let expiryFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm"
        return f
    }()
}
