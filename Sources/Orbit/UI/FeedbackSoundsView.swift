//  FeedbackSoundsView.swift
//  个性化 › 提示音: bind a sound to each dictation start/stop moment, and manage a
//  library of cues. A cue's sound is a macOS system alert, a synthesized tone, or
//  an imported audio file — all previewable ("调试") right here and in the editor.

import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct FeedbackSoundsView: View {
    @EnvironmentObject var store: SettingsStore
    @State private var player = FeedbackSoundPlayer()
    /// Non-nil while the create/edit sheet is open (a working copy of the cue).
    @State private var editing: SoundCue?

    private var fb: FeedbackSoundSettings { store.settings.feedbackSounds }

    var body: some View {
        PageScaffold(title: "个性化 · 提示音", toolbar: {
            Button { startCreate() } label: { Label("添加提示音", systemImage: "plus") }
                .controlSize(.small)
        }) {
            Form {
                Section {
                    Toggle("启用提示音", isOn: $store.settings.feedbackSounds.enabled)
                    HStack(spacing: 10) {
                        Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                        Slider(value: $store.settings.feedbackSounds.masterVolume, in: 0...1)
                        Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                    }
                    .disabled(!fb.enabled)
                } header: {
                    Text("总开关")
                } footer: {
                    Text("单击模式：点一下「开始」、再点一下「结束」。长按模式：按住「按下」、松手「松手」。每个时刻都可绑定下面库里的任意提示音。")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("触发事件") {
                    ForEach(FeedbackEvent.allCases) { event in
                        eventRow(event)
                    }
                }
                .disabled(!fb.enabled)

                Section {
                    if fb.cues.isEmpty {
                        Text("提示音库是空的。点右上角「添加提示音」，合成一个音调、挑个系统音，或导入音频文件。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(fb.cues) { cue in
                            cueRow(cue)
                        }
                    }
                } header: {
                    Text("提示音库（\(fb.cues.count)）")
                }
            }
            .formStyle(.grouped)
        }
        .sheet(item: $editing) { cue in
            SoundCueEditor(cue: cue) { saved in save(saved) }
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func eventRow(_ event: FeedbackEvent) -> some View {
        HStack(spacing: 12) {
            Image(systemName: event.symbol)
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(event.displayName)
                Text(event.summary).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Picker("", selection: binding(for: event)) {
                Text("无").tag(String?.none)
                ForEach(fb.cues) { Text($0.name).tag(Optional($0.id)) }
            }
            .labelsHidden()
            .frame(width: 170)

            Button {
                if let cue = fb.cue(for: event) { player.play(cue, masterVolume: fb.masterVolume) }
            } label: {
                Image(systemName: "play.circle")
            }
            .buttonStyle(.borderless)
            .help("试听")
            .disabled(fb.cue(for: event) == nil)
        }
    }

    @ViewBuilder
    private func cueRow(_ cue: SoundCue) -> some View {
        HStack(spacing: 12) {
            Image(systemName: cue.source.symbol)
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(cue.name.isEmpty ? "未命名" : cue.name)
                Text(cue.source.kindLabel).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button { player.play(cue, masterVolume: fb.masterVolume) } label: {
                Image(systemName: "play.circle")
            }
            .buttonStyle(.borderless).help("试听")

            Button { editing = cue } label: { Image(systemName: "pencil") }
                .buttonStyle(.borderless).help("编辑")

            Button(role: .destructive) { store.removeSoundCue(id: cue.id) } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless).help("删除")
        }
    }

    // MARK: Actions

    private func binding(for event: FeedbackEvent) -> Binding<String?> {
        Binding(
            get: { store.settings.feedbackSounds.bindings[event.rawValue] },
            set: { store.bindFeedback(event: event, to: $0) }
        )
    }

    private func startCreate() {
        editing = SoundCue(name: "新提示音", source: .tone(ToneSpec()))
    }

    private func save(_ cue: SoundCue) {
        if store.settings.feedbackSounds.cues.contains(where: { $0.id == cue.id }) {
            store.updateSoundCue(id: cue.id) { $0 = cue }
        } else {
            store.addSoundCue(cue)
        }
    }
}

// MARK: - Editor

/// Create / edit a single cue, with a live "试听" so you can debug the sound as
/// you tune it. Edits stay on a working copy until "保存".
private struct SoundCueEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var cue: SoundCue
    let onSave: (SoundCue) -> Void

    @State private var player = FeedbackSoundPlayer()

    private enum SourceKind: String, CaseIterable, Identifiable {
        case tone, system, file
        var id: String { rawValue }
        var title: String {
            switch self {
            case .tone:   return "合成音调"
            case .system: return "系统音效"
            case .file:   return "导入文件"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("名称") {
                    TextField("提示音名称", text: $cue.name)
                        .textFieldStyle(.roundedBorder)
                }

                Section("声音来源") {
                    Picker("", selection: sourceKind) {
                        ForEach(SourceKind.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    sourceControls
                }

                Section("音量") {
                    HStack(spacing: 10) {
                        Image(systemName: "speaker.fill").foregroundStyle(.secondary)
                        Slider(value: $cue.volume, in: 0...1)
                        Image(systemName: "speaker.wave.3.fill").foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)

            Divider()

            HStack(spacing: 10) {
                Button { player.play(cue) } label: { Label("试听", systemImage: "play.fill") }
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("保存") { onSave(cue); dismiss() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
            .padding(16)
        }
        .frame(width: 480, height: 460)
    }

    // MARK: Source-specific controls

    @ViewBuilder
    private var sourceControls: some View {
        switch cue.source {
        case .tone:
            Picker("波形", selection: tone.waveform) {
                ForEach(Waveform.allCases) { Text($0.displayName).tag($0) }
            }
            frequencyRow("起始音高", tone.startHz)
            frequencyRow("结束音高", tone.endHz)
            HStack {
                Text("时长")
                Slider(value: tone.duration, in: 0.03...0.6)
                Text(String(format: "%.0f ms", tone.duration.wrappedValue * 1000))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(width: 56, alignment: .trailing)
            }
            Text("起始与结束音高不同会形成「上行 / 下行」滑音 —— 开始用上行、结束用下行，听感更直观。")
                .font(.caption).foregroundStyle(.secondary)

        case .system(let name):
            Picker("系统音效", selection: systemName) {
                ForEach(FeedbackSoundSettings.systemSoundNames, id: \.self) { Text($0).tag($0) }
            }
            Text("使用 macOS 内置的提示音「\(name)」。")
                .font(.caption).foregroundStyle(.secondary)

        case .file(let filename):
            HStack {
                Image(systemName: "music.note")
                Text(filename.isEmpty ? "未选择文件" : filename)
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(filename.isEmpty ? .secondary : .primary)
                Spacer()
                Button("选择文件…") { pickFile() }
            }
            Text("支持 .wav / .aiff / .mp3 / .m4a / .caf —— 文件会复制进 Orbit 的应用目录统一管理。")
                .font(.caption).foregroundStyle(.secondary)

        case .silent:
            Text("静音。").foregroundStyle(.secondary)
        }
    }

    private func frequencyRow(_ label: String, _ value: Binding<Double>) -> some View {
        HStack {
            Text(label)
            Slider(value: value, in: 120...2000)
            Text(String(format: "%.0f Hz", value.wrappedValue))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 56, alignment: .trailing)
        }
    }

    // MARK: Bindings into the source's associated value

    private var sourceKind: Binding<SourceKind> {
        Binding(
            get: {
                switch cue.source {
                case .system: return .system
                case .file:   return .file
                case .tone, .silent: return .tone
                }
            },
            set: { kind in
                switch kind {
                case .tone:
                    if case .tone = cue.source {} else { cue.source = .tone(ToneSpec()) }
                case .system:
                    if case .system = cue.source {} else { cue.source = .system("Tink") }
                case .file:
                    if case .file = cue.source {} else { cue.source = .file("") }
                }
            }
        )
    }

    private var tone: Binding<ToneSpec> {
        Binding(
            get: { if case .tone(let t) = cue.source { return t } else { return ToneSpec() } },
            set: { cue.source = .tone($0) }
        )
    }

    private var systemName: Binding<String> {
        Binding(
            get: { if case .system(let n) = cue.source { return n } else { return "Tink" } },
            set: { cue.source = .system($0) }
        )
    }

    private func pickFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.audio]
        panel.prompt = "导入"
        guard panel.runModal() == .OK, let url = panel.url,
              let filename = FeedbackSoundPlayer.importFile(from: url) else { return }
        cue.source = .file(filename)
    }
}
