//  ShortcutsView.swift
//  个性化 › 快捷键: bind global shortcut chords (a modifier + key) to actions —
//  open an app, open a file/URL, or run a command. Managed as a table with a
//  modal editor, mirroring the polish-templates page. The chord is captured by a
//  native recorder control (KeyCaptureView) and matched by the same global event
//  tap that powers dictation, so it needs 辅助功能 permission to fire.

import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct ShortcutsView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var app: AppController

    @State private var selectedID: ActionShortcut.ID?
    @State private var showingAdd = false
    @State private var editingShortcut: ActionShortcut?

    private var shortcuts: [ActionShortcut] { store.settings.shortcuts }

    private var selected: ActionShortcut? {
        guard let id = selectedID else { return nil }
        return shortcuts.first { $0.id == id }
    }

    var body: some View {
        PageScaffold(title: "快捷键", maxWidth: .infinity) {
            HStack(spacing: 8) {
                Button {
                    if let s = selected { editingShortcut = s }
                } label: {
                    Label("编辑", systemImage: "pencil")
                }
                .disabled(selected == nil)

                Button {
                    if let id = selectedID {
                        store.removeShortcut(id: id)
                        selectedID = nil
                    }
                } label: {
                    Label("删除", systemImage: "trash")
                }
                .disabled(selectedID == nil)

                Button { showingAdd = true } label: {
                    Label("添加快捷键", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                Text("为常用操作绑定全局快捷键。推荐用「⌃ + 字母」——这类组合很少被 macOS 或其它应用占用。快捷键在任意应用中都会生效，命中后原按键不会传给当前应用。")
                    .font(.caption).foregroundStyle(.secondary)

                if app.axPermission != .granted {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text("未授予「辅助功能」，全局快捷键无法触发。")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("去授权") { app.requestAccessibility() }.controlSize(.small)
                    }
                    .padding(.vertical, 2)
                }

                Table(shortcuts, selection: $selectedID) {
                    TableColumn("快捷键") { s in
                        ComboChips(keyCode: s.keyCode, modifiers: s.modifiers)
                            .opacity(s.enabled ? 1 : 0.4)
                    }
                    TableColumn("动作") { s in
                        Label(s.actionKind.displayName, systemImage: s.actionKind.symbol)
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(.secondary)
                    }
                    TableColumn("目标") { s in
                        Text(s.displayLabel)
                            .foregroundStyle(s.enabled ? .primary : .secondary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                    TableColumn("启用") { s in
                        Toggle("", isOn: Binding(
                            get: { s.enabled },
                            set: { on in store.updateShortcut(id: s.id) { $0.enabled = on } }
                        ))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.mini)
                    }
                    .width(52)
                }
                .tableStyle(.inset)
                .contextMenu(forSelectionType: ActionShortcut.ID.self) { ids in
                    if let id = ids.first, let s = shortcuts.first(where: { $0.id == id }) {
                        Button("编辑") { editingShortcut = s }
                        Button("删除", role: .destructive) {
                            store.removeShortcut(id: s.id)
                            if selectedID == s.id { selectedID = nil }
                        }
                    }
                } primaryAction: { ids in
                    if let id = ids.first, let s = shortcuts.first(where: { $0.id == id }) {
                        editingShortcut = s
                    }
                }
                .overlay {
                    if shortcuts.isEmpty {
                        Text("还没有快捷键。点右上角「添加快捷键」，录一个组合键并绑定一个动作。")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.bottom, 16)
            }
        }
        .onAppear { app.refreshStatus() }
        .sheet(isPresented: $showingAdd) {
            ShortcutEditorSheet(existing: shortcuts) { newShortcut in
                store.addShortcut(newShortcut)
            }
        }
        .sheet(item: $editingShortcut) { shortcut in
            ShortcutEditorSheet(editing: shortcut, existing: shortcuts) { updated in
                store.updateShortcut(id: shortcut.id) { s in
                    s.keyCode = updated.keyCode
                    s.modifiers = updated.modifiers
                    s.actionKind = updated.actionKind
                    s.target = updated.target
                    s.label = updated.label
                }
            }
        }
    }
}

// MARK: - Combo chips

/// Renders a chord as individual key caps: `⌃` `⌥` `K`.
private struct ComboChips: View {
    let keyCode: Int
    let modifiers: KeyModifiers

    private var tokens: [String] {
        var t: [String] = []
        if modifiers.contains(.control) { t.append("⌃") }
        if modifiers.contains(.option)  { t.append("⌥") }
        if modifiers.contains(.shift)   { t.append("⇧") }
        if modifiers.contains(.command) { t.append("⌘") }
        t.append(Keycodes.keyLabel(for: keyCode))
        return t
    }

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(tokens.enumerated()), id: \.offset) { _, token in
                Text(token)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .frame(minWidth: 18)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
    }
}

// MARK: - Editor sheet

private struct ShortcutEditorSheet: View {
    var editing: ActionShortcut?
    var existing: [ActionShortcut]
    var onSave: (ActionShortcut) -> Void

    @EnvironmentObject private var app: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ActionShortcut

    init(editing: ActionShortcut? = nil,
         existing: [ActionShortcut],
         onSave: @escaping (ActionShortcut) -> Void) {
        self.editing = editing
        self.existing = existing
        self.onSave = onSave
        _draft = State(initialValue: editing ?? ActionShortcut())
    }

    /// Another binding already using this exact chord.
    private var conflict: ActionShortcut? {
        guard !draft.modifiers.isEmpty else { return nil }
        return existing.first {
            $0.id != draft.id && $0.keyCode == draft.keyCode && $0.modifiers == draft.modifiers
        }
    }

    private var canSave: Bool { draft.isValid && conflict == nil }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(editing == nil ? "添加快捷键" : "编辑快捷键").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
            Divider()

            VStack(alignment: .leading, spacing: 16) {
                // Chord recorder.
                field("快捷键") {
                    VStack(alignment: .leading, spacing: 6) {
                        ShortcutRecorderField(
                            keyCode: $draft.keyCode,
                            modifiers: $draft.modifiers,
                            onStartRecording: { app.beginShortcutRecording() },
                            onEndRecording: { app.endShortcutRecording() }
                        )
                        if let conflict {
                            Text("已被「\(conflict.displayLabel)」占用，换一个组合。")
                                .font(.caption).foregroundStyle(.orange)
                        } else if !draft.modifiers.isEmpty && draft.modifiers == [.shift] {
                            Text("建议至少包含 ⌃ / ⌥ / ⌘，只用 ⇧ 容易和正常输入冲突。")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("点上方方框后按下组合键，例如 ⌃ + K。按 Esc 取消录制。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }

                // Action kind.
                field("动作") {
                    Picker("", selection: $draft.actionKind) {
                        ForEach(ShortcutActionKind.allCases) { kind in
                            Label(kind.displayName, systemImage: kind.symbol).tag(kind)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    .onChange(of: draft.actionKind) { _, _ in
                        draft.target = ""
                        draft.label = ""
                    }
                }

                // Target — an app picker or a free-form field.
                field(draft.actionKind == .openApp ? "应用" : "目标") {
                    targetEditor
                }

                // Optional display name.
                field("名称") {
                    TextField(draft.actionKind == .openApp ? "留空则用应用名" : "可选，便于识别",
                              text: $draft.label)
                        .textFieldStyle(.roundedBorder)
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 18)

            Divider()
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    var s = draft
                    s.target = s.target.trimmed
                    s.label = s.label.trimmed
                    onSave(s)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(!canSave)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
        }
        .frame(width: 520)
    }

    @ViewBuilder
    private var targetEditor: some View {
        switch draft.actionKind {
        case .openApp:
            HStack(spacing: 10) {
                if draft.target.isEmpty {
                    Text("未选择应用").foregroundStyle(.secondary)
                } else {
                    Label(draft.displayLabel, systemImage: "app")
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                Button("选择应用…") { pickApp() }
            }
        case .openTarget, .runCommand:
            TextField(draft.actionKind.targetPrompt, text: $draft.target)
                .textFieldStyle(.roundedBorder)
                .font(draft.actionKind == .runCommand
                      ? .system(.body, design: .monospaced) : .body)
        }
    }

    private func field<Content: View>(_ title: String,
                                      @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).frame(width: 56, alignment: .leading).foregroundStyle(.secondary)
            content()
        }
    }

    private func pickApp() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.application]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.prompt = "选择"
        if panel.runModal() == .OK, let url = panel.url {
            draft.target = url.path
            if draft.label.trimmed.isEmpty {
                draft.label = url.deletingPathExtension().lastPathComponent
            }
        }
    }
}

// MARK: - Native recorder control

/// A focusable box that records the next chord the user presses. Clicking it
/// starts recording; the invisible `KeyCaptureView` overlay grabs the keyDown.
/// Internal (not private): the capture settings page reuses it for the
/// screenshot / pin feature chords.
struct ShortcutRecorderField: View {
    @Binding var keyCode: Int
    @Binding var modifiers: KeyModifiers
    var onStartRecording: () -> Void = {}
    var onEndRecording: () -> Void = {}

    @State private var isRecording = false

    private var hasBinding: Bool { !modifiers.isEmpty }

    var body: some View {
        Button {
            guard !isRecording else { return }
            isRecording = true
            onStartRecording()
        } label: {
            HStack {
                if isRecording {
                    Text("请按下组合键…")
                        .foregroundStyle(.secondary)
                } else if hasBinding {
                    ComboChips(keyCode: keyCode, modifiers: modifiers)
                } else {
                    Text("点击录制（⌃ + 字母）")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: isRecording ? "record.circle" : "keyboard")
                    .foregroundStyle(isRecording ? .red : .secondary)
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(isRecording ? Color.accentColor : Color.primary.opacity(0.12),
                                  lineWidth: isRecording ? 2 : 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay {
            if isRecording {
                KeyCaptureView(
                    onCapture: { code, mods in
                        keyCode = code
                        modifiers = mods
                        stop()
                    },
                    onCancel: { stop() }
                )
            }
        }
        .onDisappear { if isRecording { stop() } }
    }

    private func stop() {
        guard isRecording else { return }
        isRecording = false
        onEndRecording()
    }
}

/// NSViewRepresentable wrapper: becomes first responder and reports the next
/// chord. Escape cancels; a key with no modifier beeps and keeps listening.
private struct KeyCaptureView: NSViewRepresentable {
    var onCapture: (Int, KeyModifiers) -> Void
    var onCancel: () -> Void

    func makeNSView(context: Context) -> KeyRecorderNSView {
        let v = KeyRecorderNSView()
        v.onCapture = onCapture
        v.onCancel = onCancel
        return v
    }

    func updateNSView(_ nsView: KeyRecorderNSView, context: Context) {
        nsView.onCapture = onCapture
        nsView.onCancel = onCancel
        nsView.grabFocus()
    }
}

final class KeyRecorderNSView: NSView {
    var onCapture: ((Int, KeyModifiers) -> Void)?
    var onCancel: (() -> Void)?
    private var finished = false

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        grabFocus()
    }

    /// Take first-responder focus (async so it survives the SwiftUI layout pass).
    func grabFocus() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window, window.firstResponder !== self else { return }
            window.makeFirstResponder(self)
        }
    }

    override func keyDown(with event: NSEvent) {
        let code = Int(event.keyCode)
        let mods = KeyModifiers(nsFlags: event.modifierFlags)
        if code == 53, mods.isEmpty {         // Esc → cancel
            finish { $0.onCancel?() }
            return
        }
        guard !mods.isEmpty else {            // needs a modifier
            NSSound.beep()
            return
        }
        finish { $0.onCapture?(code, mods) }
    }

    override func resignFirstResponder() -> Bool {
        // Focus lost without a capture (clicked elsewhere) → treat as cancel.
        if !finished { finish { $0.onCancel?() } }
        return super.resignFirstResponder()
    }

    private func finish(_ report: @escaping (KeyRecorderNSView) -> Void) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            report(self)
        }
    }
}
