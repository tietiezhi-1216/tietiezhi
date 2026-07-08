//  CaptureSettingsViews.swift
//  截图 › 基础 / 历史 settings pages. Basic: the two feature chords, finish
//  behaviour, the AI-annotate model note, and the screen-recording permission
//  state. History: a thumbnail grid of past captures with copy / pin / save /
//  delete actions.

import AppKit
import SwiftUI

// MARK: - 基础

struct CaptureBasicView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var app: AppController

    var body: some View {
        PageScaffold(title: "截图 · 基础", toolbar: {
            Button {
                app.startCapture(afterDelay: 0.4)
            } label: {
                Label("立即截图", systemImage: "camera.viewfinder")
            }
        }) {
            Form {
                Section("快捷键（全局生效）") {
                    chordRow(title: "区域截图",
                             keyCode: $store.settings.capture.captureChord.keyCode,
                             modifiers: $store.settings.capture.captureChord.modifiers)
                    chordRow(title: "贴图（剪贴板图片贴到屏幕）",
                             keyCode: $store.settings.capture.pinChord.keyCode,
                             modifiers: $store.settings.capture.pinChord.modifiers)
                    hint("框选后：拖拽=框选区域，单击=选中窗口，C=取色，Esc=取消；确认选区后可手动标注，或在选区下方直接对 AI 说要标什么。")
                }

                Section("完成行为") {
                    Toggle("完成后自动复制到剪贴板", isOn: $store.settings.capture.copyAfterCapture)
                    Toggle("完成后显示左下角悬浮预览（可拖拽发送）", isOn: $store.settings.capture.showQuickPreview)
                }

                Section("AI 标注") {
                    Picker("使用模型", selection: $store.settings.captureModelID) {
                        Text(followLabel).tag(String?.none)
                        ForEach(chatModels) {
                            Text(store.settings.displayLabel(for: $0)).tag(Optional($0.id))
                        }
                    }
                    if chatModels.isEmpty {
                        hint("还没有大模型。去「渠道商」添加一个支持视觉（多模态）的聊天模型，保存后会自动加载。")
                    }
                    hint(aiModelHint)
                }

                Section("权限") {
                    LabeledContent("屏幕录制") {
                        HStack(spacing: 10) {
                            if app.screenRecordingPermission == .granted {
                                Label("已授权", systemImage: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            } else {
                                Label("未授权", systemImage: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                                Button("去授权") {
                                    app.requestScreenRecording()
                                    Permissions.openScreenRecordingSettings()
                                }
                            }
                        }
                        .font(.callout)
                    }
                    hint("截图与贴图共用「屏幕录制」权限。macOS 15 起系统会每月弹窗确认一次，属正常机制，点「继续允许」即可。")
                }
            }
            .formStyle(.grouped)
            .onAppear { app.refreshStatus() }
        }
    }

    private var chatModels: [ModelConfig] {
        store.settings.chatModels
    }

    /// Label for the "follow the shared model" option, naming what it resolves to.
    private var followLabel: String {
        if let m = store.settings.llmModel {
            return "跟随聊天 / 听写模型（\(store.settings.displayLabel(for: m))）"
        }
        return "跟随聊天 / 听写模型"
    }

    private var aiModelHint: String {
        guard let model = store.settings.captureAnnotationModel else {
            return "AI 标注需要一个支持视觉（多模态）的聊天模型。当前没有可用模型——去「渠道商」配置并选中一个。"
        }
        if !model.llmCapabilities.multimodal {
            return "当前模型「\(store.settings.displayLabel(for: model))」未开启多模态，AI 看不到截图。请在渠道商的模型编辑里开启多模态，或换用视觉模型（如 GPT-4o / Claude / Qwen-VL）。"
        }
        if store.settings.captureModelID == nil {
            return "默认与聊天 / 听写润色共用同一个模型；也可在上面单独指定一个视觉模型。工具调用与视觉输入都走它。"
        }
        return "已单独指定标注模型：\(store.settings.displayLabel(for: model))。"
    }

    private func chordRow(title: String, keyCode: Binding<Int>,
                          modifiers: Binding<KeyModifiers>) -> some View {
        LabeledContent(title) {
            ShortcutRecorderField(
                keyCode: keyCode,
                modifiers: modifiers,
                onStartRecording: { app.beginShortcutRecording() },
                onEndRecording: { app.endShortcutRecording() }
            )
            .frame(width: 220)
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - 历史

struct CaptureHistoryView: View {
    @EnvironmentObject var history: ScreenshotHistoryStore
    @EnvironmentObject var app: AppController
    @State private var confirmClear = false

    private let columns = [GridItem(.adaptive(minimum: 170, maximum: 240), spacing: 14)]

    var body: some View {
        PageScaffold(title: "截图 · 历史", maxWidth: .infinity, toolbar: {
            if !history.entries.isEmpty {
                Button(role: .destructive) { confirmClear = true } label: {
                    Label("清空", systemImage: "trash")
                }
                .confirmationDialog("清空全部截图历史？图片文件也会一并删除。",
                                    isPresented: $confirmClear, titleVisibility: .visible) {
                    Button("清空", role: .destructive) { history.clear() }
                }
            }
        }) {
            if history.entries.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "camera.viewfinder")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(.tertiary)
                    Text("还没有截图。按 \(chordDisplay) 截一张试试。")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(history.entries) { entry in
                            CaptureHistoryCell(entry: entry)
                        }
                    }
                    .padding(.bottom, 24)
                }
            }
        }
    }

    @EnvironmentObject private var store: SettingsStore
    private var chordDisplay: String { store.settings.capture.captureChord.display }
}

private struct CaptureHistoryCell: View {
    let entry: ScreenshotEntry
    @EnvironmentObject var history: ScreenshotHistoryStore
    @EnvironmentObject var app: AppController
    @State private var thumbnail: NSImage?
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                thumb
                if hovering { actions }
            }
            HStack(spacing: 6) {
                Text(entry.date, format: .dateTime.month().day().hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if entry.aiPrompt != nil {
                    Label("AI", systemImage: "sparkles")
                        .font(.system(size: 9, weight: .semibold))
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(.purple.opacity(0.15), in: Capsule())
                        .foregroundStyle(.purple)
                        .labelStyle(.titleAndIcon)
                        .help(entry.aiPrompt ?? "")
                }
                Spacer(minLength: 0)
                Text("\(entry.width)×\(entry.height)")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
        .onHover { hovering = $0 }
    }

    private var thumb: some View {
        Group {
            if let thumbnail {
                Image(nsImage: thumbnail)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Rectangle().fill(.quaternary)
            }
        }
        .frame(height: 118)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(.primary.opacity(0.1)))
        .task(id: entry.id) {
            let path = entry.imagePath
            thumbnail = await Task.detached(priority: .utility) {
                NSImage(contentsOfFile: path)
            }.value
        }
        .onDrag { NSItemProvider(contentsOf: entry.imageURL) ?? NSItemProvider() }
    }

    private var actions: some View {
        HStack(spacing: 5) {
            actionButton("doc.on.doc", help: "复制") {
                if let image = NSImage(contentsOfFile: entry.imagePath) {
                    let pb = NSPasteboard.general
                    pb.clearContents()
                    pb.writeObjects([image])
                }
            }
            actionButton("pin", help: "贴到屏幕") {
                if let image = NSImage(contentsOfFile: entry.imagePath) {
                    app.pinImage(image)
                }
            }
            actionButton("square.and.arrow.down", help: "另存为…") {
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.png]
                panel.nameFieldStringValue = "Orbit 截图.png"
                panel.begin { response in
                    guard response == .OK, let url = panel.url else { return }
                    try? FileManager.default.copyItem(at: entry.imageURL, to: url)
                }
            }
            actionButton("trash", help: "删除") {
                history.remove(id: entry.id)
            }
        }
        .padding(6)
    }

    private func actionButton(_ icon: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 23, height: 23)
                .background(Circle().fill(Color.black.opacity(0.62)))
        }
        .buttonStyle(.plain)
        .help(help)
    }
}
