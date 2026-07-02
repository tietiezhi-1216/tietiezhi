//  CreationWorkspaceView.swift
//  首页「创作」工作区：与对话分开的设计面板。左侧在 图像 / 视频 之间切换并可返回
//  对话；右侧是对应的生成面板（选模型 + 提示词 + 参数 → 生成 → 画廊）。视频面板
//  在 Phase B 接入。

import SwiftUI
import AppKit
import AVKit

struct CreationWorkspaceView: View {
    let openSettings: () -> Void
    @EnvironmentObject private var app: AppController

    var body: some View {
        HStack(spacing: 0) {
            rail.frame(width: 232)
            Divider()
            Group {
                switch app.creationTab {
                case .image: ImageStudioView()
                case .video: VideoStudioView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var rail: some View {
        ZStack {
            VisualEffectView(material: .sidebar).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 4) {
                Color.clear.frame(height: 44)
                RailButton(title: "返回对话", systemImage: "bubble.left.and.bubble.right") {
                    app.openChatWorkspace()
                }
                Divider().padding(.vertical, 6)
                RailButton(title: "图像", systemImage: "photo",
                           isSelected: app.creationTab == .image) { app.creationTab = .image }
                RailButton(title: "视频", systemImage: "film",
                           isSelected: app.creationTab == .video) { app.creationTab = .video }
                Spacer()
                RailButton(title: "设置", systemImage: "gearshape") { openSettings() }
            }
            .padding(.horizontal, 12).padding(.bottom, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

}

private struct RailButton: View {
    let title: String
    let systemImage: String
    var isSelected = false
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage).frame(width: 18)
                Text(title).font(.system(size: 14))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).frame(height: 30)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.white.opacity(0.16) : (hover ? Color.white.opacity(0.1) : .clear),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

// MARK: - Image studio

private struct ImageStudioView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var generation: GenerationStore

    @State private var prompt = ""
    @State private var size = "1024x1024"
    @State private var count = 1
    @State private var negative = ""

    private var models: [ModelConfig] { store.settings.imageModels }
    private var selected: ModelConfig? { store.settings.imageModel }
    private var isSiliconFlow: Bool {
        selected.flatMap { store.settings.adapter(for: $0) }?.id == "siliconflow"
    }
    private var sizes: [String] { ["1024x1024", "1792x1024", "1024x1792", "768x1024", "512x512"] }

    var body: some View {
        PageScaffold(title: "创作 · 图像", maxWidth: 900) {
            if models.isEmpty {
                emptyState
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    controls
                    if let err = generation.lastError {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange).lineLimit(3)
                    }
                    gallery
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "photo.on.rectangle.angled").font(.system(size: 40)).foregroundStyle(.secondary)
            Text("还没有图像模型。去「渠道商」添加一个支持图像的渠道商（OpenAI / SiliconFlow / 自定义），加载模型后回来。")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Picker("模型", selection: Binding(
                    get: { store.settings.imageModelID ?? models.first?.id },
                    set: { store.settings.imageModelID = $0 }
                )) {
                    ForEach(models) { Text(store.settings.displayLabel(for: $0)).tag(Optional($0.id)) }
                }
                .frame(maxWidth: 340)

                Picker("尺寸", selection: $size) {
                    ForEach(sizes, id: \.self) { Text($0).tag($0) }
                }
                .frame(width: 150)

                Stepper("数量 \(count)", value: $count, in: 1...4)
                    .fixedSize()
            }

            TextField("负向提示词（可选，SiliconFlow 支持）", text: $negative)
                .textFieldStyle(.roundedBorder)
                .opacity(isSiliconFlow ? 1 : 0.4).disabled(!isSiliconFlow)

            VStack(alignment: .leading, spacing: 6) {
                Text("提示词").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $prompt)
                    .font(.body).frame(height: 90)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
            }

            HStack {
                Button {
                    generate()
                } label: {
                    Label(generation.isGenerating ? "生成中…" : "生成", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent)
                .disabled(generation.isGenerating || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selected == nil)

                if generation.isGenerating {
                    ProgressView().controlSize(.small)
                    Button("取消") { generation.cancel() }.controlSize(.small)
                }
                Spacer()
            }
        }
    }

    private func generate() {
        guard let model = selected else { return }
        var params: [String: String] = ["size": size, "n": String(count)]
        if isSiliconFlow, !negative.isEmpty { params["negative_prompt"] = negative }
        generation.generateImage(model: model, prompt: prompt, params: params)
    }

    private var gallery: some View {
        let images = generation.items(kind: "image")
        return Group {
            if images.isEmpty {
                Text("生成的图片会显示在这里，并自动保存。").font(.caption).foregroundStyle(.tertiary)
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                        ForEach(images) { item in
                            ImageCard(item: item) { generation.remove(id: item.id) }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }
}

// MARK: - Video studio

private struct VideoStudioView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var generation: GenerationStore

    @State private var prompt = ""
    @State private var size = "1280x720"
    @State private var seconds = "4"

    private var models: [ModelConfig] { store.settings.videoModels }
    private var selected: ModelConfig? { store.settings.videoModel ?? models.first }
    private var isSora: Bool {
        selected.flatMap { store.settings.service(for: $0)?.wire } == .openAIVideo
    }
    private var sizes: [String] { ["1280x720", "720x1280", "960x960", "1024x1792", "1792x1024"] }

    var body: some View {
        PageScaffold(title: "创作 · 视频", maxWidth: 900) {
            if models.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "film").font(.system(size: 40)).foregroundStyle(.secondary)
                    Text("还没有视频模型。去「渠道商」添加支持视频的渠道商（OpenAI Sora / SiliconFlow），加载模型后回来。")
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .frame(maxWidth: 420)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    controls
                    if let err = generation.lastError {
                        Label(err, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange).lineLimit(3)
                    }
                    gallery
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Picker("模型", selection: Binding(
                    get: { store.settings.videoModelID ?? models.first?.id },
                    set: { store.settings.videoModelID = $0 }
                )) {
                    ForEach(models) { Text(store.settings.displayLabel(for: $0)).tag(Optional($0.id)) }
                }
                .frame(maxWidth: 340)

                Picker("尺寸", selection: $size) {
                    ForEach(sizes, id: \.self) { Text($0).tag($0) }
                }
                .frame(width: 150)

                if isSora {
                    Picker("时长", selection: $seconds) {
                        Text("4 秒").tag("4"); Text("8 秒").tag("8"); Text("12 秒").tag("12")
                    }
                    .frame(width: 120)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("提示词").font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $prompt)
                    .font(.body).frame(height: 90)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
            }

            HStack(spacing: 10) {
                Button {
                    guard let model = selected else { return }
                    generation.generateVideo(model: model, prompt: prompt,
                                             params: ["size": size, "seconds": seconds])
                } label: {
                    Label(generation.isGenerating ? "生成中…" : "生成视频", systemImage: "sparkles")
                }
                .buttonStyle(.borderedProminent)
                .disabled(generation.isGenerating
                          || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || selected == nil)

                if generation.isGenerating {
                    if let p = generation.videoProgress {
                        ProgressView(value: p).frame(width: 140)
                    } else {
                        ProgressView().controlSize(.small)
                    }
                    Text(generation.videoStatus ?? "").font(.caption).foregroundStyle(.secondary)
                    Button("取消") { generation.cancel() }.controlSize(.small)
                }
                Spacer()
            }
            Text("视频为异步生成，通常需要几十秒到几分钟；生成期间可切到其它页面。")
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private var gallery: some View {
        let videos = generation.items(kind: "video")
        return Group {
            if videos.isEmpty {
                Text("生成的视频会显示在这里，并自动保存。").font(.caption).foregroundStyle(.tertiary)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(videos) { item in
                            VideoCard(item: item) { generation.remove(id: item.id) }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }
}

private struct VideoCard: View {
    let item: GeneratedItem
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VideoPlayer(player: AVPlayer(url: item.fileURL))
                .frame(height: 280)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            HStack {
                Text(item.prompt).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Spacer()
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([item.fileURL])
                } label: { Image(systemName: "folder") }
                    .buttonStyle(.borderless).help("在访达中显示")
                Button(role: .destructive, action: onDelete) { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
            }
        }
    }
}

private struct ImageCard: View {
    let item: GeneratedItem
    let onDelete: () -> Void
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack(alignment: .topTrailing) {
                thumbnail
                if hover {
                    Button(action: onDelete) { Image(systemName: "trash.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.white, .black.opacity(0.5))
                        .padding(6)
                }
            }
            Text(item.prompt).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }
        .onHover { hover = $0 }
    }

    @ViewBuilder private var thumbnail: some View {
        if let img = NSImage(contentsOf: item.fileURL) {
            Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                .frame(height: 180).frame(maxWidth: .infinity).clipped()
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onTapGesture(count: 2) { NSWorkspace.shared.open(item.fileURL) }
        } else {
            RoundedRectangle(cornerRadius: 10).fill(.quaternary)
                .frame(height: 180)
                .overlay(Image(systemName: "photo").foregroundStyle(.secondary))
        }
    }
}
