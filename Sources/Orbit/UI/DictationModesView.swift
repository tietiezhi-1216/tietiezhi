//  DictationModesView.swift
//  听写 › 模板: manage polish templates as a table (name / active / preview),
//  with add & edit happening in a modal sheet — template bodies are long system
//  prompts and editing them inline made the page unmanageable. The active one
//  is the system prompt sent to the model; the transcript is sent separately as
//  data. Hotwords are folded in by the system (PromptComposer); an optional
//  `{{HOTWORDS}}` slot lets an advanced user choose where that block lands.

import SwiftUI

struct DictationModesView: View {
    @EnvironmentObject var store: SettingsStore

    @State private var selectedID: PromptTemplate.ID?
    @State private var showingAdd = false
    @State private var editingTemplate: PromptTemplate?

    private var templates: [PromptTemplate] { store.settings.templates }
    private var activeID: String? { store.settings.activeTemplateID }

    private var selectedTemplate: PromptTemplate? {
        guard let id = selectedID else { return nil }
        return templates.first { $0.id == id }
    }

    var body: some View {
        PageScaffold(title: "听写 · 模板", maxWidth: .infinity) {
            HStack(spacing: 8) {
                Button {
                    if let t = selectedTemplate { store.settings.activeTemplateID = t.id }
                } label: {
                    Label("设为当前", systemImage: "checkmark.circle")
                }
                .disabled(selectedTemplate == nil || selectedID == activeID)

                Button {
                    if let t = selectedTemplate { editingTemplate = t }
                } label: {
                    Label("编辑", systemImage: "pencil")
                }
                .disabled(selectedTemplate == nil)

                Button {
                    if let id = selectedID {
                        store.removeTemplate(id: id)
                        selectedID = nil
                    }
                } label: {
                    Label("删除", systemImage: "trash")
                }
                .disabled(selectedID == nil)

                Button { showingAdd = true } label: {
                    Label("添加模板", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                Text("单击模式识别后，用「当前」模板润色一遍；长按只转写、不润色。模板就是发给模型的系统提示词，转写作为数据单独发送。热词由系统自动加入，模板只写润色规则即可。")
                    .font(.caption).foregroundStyle(.secondary)

                Table(templates, selection: $selectedID) {
                    TableColumn("名称") { t in
                        Text(t.name.isEmpty ? "未命名模板" : t.name)
                    }
                    TableColumn("当前") { t in
                        if t.id == activeID {
                            Label("当前使用", systemImage: "checkmark.circle.fill")
                                .labelStyle(.titleAndIcon)
                                .font(.caption).foregroundStyle(Color.accentColor)
                        } else {
                            Text("—").foregroundStyle(.tertiary)
                        }
                    }
                    TableColumn("内容预览") { t in
                        Text(preview(t))
                            .foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    TableColumn("字数") { t in
                        Text("\(t.template.count)")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                .tableStyle(.inset)
                .contextMenu(forSelectionType: PromptTemplate.ID.self) { ids in
                    if let id = ids.first, let t = templates.first(where: { $0.id == id }) {
                        Button("设为当前") { store.settings.activeTemplateID = t.id }
                            .disabled(t.id == activeID)
                        Button("编辑") { editingTemplate = t }
                        Button("删除", role: .destructive) {
                            store.removeTemplate(id: t.id)
                            if selectedID == t.id { selectedID = nil }
                        }
                    }
                } primaryAction: { ids in
                    // Double-click opens the editor.
                    if let id = ids.first, let t = templates.first(where: { $0.id == id }) {
                        editingTemplate = t
                    }
                }
                .overlay {
                    if templates.isEmpty {
                        Text("还没有模板。点右上角「添加模板」，写上你想要的润色风格。")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.bottom, 16)
            }
        }
        .sheet(isPresented: $showingAdd) {
            TemplateEditorSheet { newTemplate in
                store.addTemplate(newTemplate)
                if store.settings.activeTemplateID == nil {
                    store.settings.activeTemplateID = newTemplate.id
                }
            }
        }
        .sheet(item: $editingTemplate) { template in
            TemplateEditorSheet(editing: template) { updated in
                store.updateTemplate(id: template.id) { existing in
                    existing.name = updated.name
                    existing.template = updated.template
                }
            }
        }
    }

    private func preview(_ t: PromptTemplate) -> String {
        let flat = t.template.replacingOccurrences(of: "\n", with: " ").trimmed
        return flat.isEmpty ? "（空）" : String(flat.prefix(80))
    }
}

// MARK: - Template editor sheet

private struct TemplateEditorSheet: View {
    var editing: PromptTemplate?
    var onSave: (PromptTemplate) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: PromptTemplate

    init(editing: PromptTemplate? = nil, onSave: @escaping (PromptTemplate) -> Void) {
        self.editing = editing
        self.onSave = onSave
        _draft = State(initialValue: editing ?? PromptTemplate(name: "", template: ""))
    }

    private var canSave: Bool { !draft.name.trimmed.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(editing == nil ? "添加模板" : "编辑模板").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
            Divider()

            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("名称").frame(width: 44, alignment: .leading).foregroundStyle(.secondary)
                    TextField("例如：完全重写、轻度润色、会议纪要", text: $draft.name)
                        .textFieldStyle(.roundedBorder)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("系统提示词").font(.caption).foregroundStyle(.secondary)
                    TextEditor(text: $draft.template)
                        .font(.system(.callout, design: .monospaced))
                        .frame(maxHeight: .infinity)
                        .overlay(alignment: .topLeading) {
                            if draft.template.isEmpty {
                                Text("写下系统提示词，只描述如何润色即可…")
                                    .font(.system(.callout, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 8).padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
                    Text("热词由系统自动附加；高级用法：写 `{{HOTWORDS}}` 可指定热词块出现的位置。")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 16)

            Divider()
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    var t = draft
                    t.name = t.name.trimmed
                    onSave(t)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(!canSave)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
        }
        .frame(width: 640, height: 560)
    }
}
