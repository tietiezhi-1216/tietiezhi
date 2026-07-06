//  AgentsView.swift
//  功能 › 智能体: manage chat agents (Trae-style personas). Each agent bundles a
//  system prompt with a chosen set of tools/skills; the active one is switched
//  from the chat composer. Table + modal editor, mirroring the templates page.

import SwiftUI
import AppKit

struct AgentsView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var registry: ToolRegistry
    @EnvironmentObject var skills: SkillStore

    @State private var selectedID: Agent.ID?
    @State private var showingAdd = false
    @State private var editingAgent: Agent?

    private var agents: [Agent] { store.settings.agents }
    private var activeID: String? { store.settings.activeAgentID }

    private var selected: Agent? {
        guard let id = selectedID else { return nil }
        return agents.first { $0.id == id }
    }

    var body: some View {
        PageScaffold(title: "功能 · 智能体", maxWidth: .infinity) {
            HStack(spacing: 8) {
                Button {
                    if let a = selected { store.setActiveAgent(id: a.id) }
                } label: { Label("设为当前", systemImage: "checkmark.circle") }
                .disabled(selected == nil || selectedID == activeID)

                Button {
                    if let a = selected { editingAgent = a }
                } label: { Label("编辑", systemImage: "pencil") }
                .disabled(selected == nil)

                Button {
                    if let id = selectedID { store.removeAgent(id: id); selectedID = nil }
                } label: { Label("删除", systemImage: "trash") }
                .disabled(selectedID == nil)

                Button { showingAdd = true } label: {
                    Label("添加智能体", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            VStack(alignment: .leading, spacing: 10) {
                Text("每个智能体 = 一段系统提示词 + 一组勾选的工具/技能。在首页对话时可切换当前智能体，让同一个模型扮演不同角色、带不同能力。")
                    .font(.caption).foregroundStyle(.secondary)

                Table(agents, selection: $selectedID) {
                    TableColumn("名称") { a in
                        HStack(spacing: 6) {
                            Image(systemName: a.icon)
                                .frame(width: 18, alignment: .center)
                                .foregroundStyle(.secondary)
                            Text(a.displayName)
                        }
                    }
                    TableColumn("当前") { a in
                        if a.id == activeID {
                            Label("当前", systemImage: "checkmark.circle.fill")
                                .labelStyle(.titleAndIcon).font(.caption)
                                .foregroundStyle(Color.accentColor)
                        } else {
                            Text("—").foregroundStyle(.tertiary)
                        }
                    }
                    TableColumn("提示词预览") { a in
                        Text(preview(a)).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                    TableColumn("工具") { a in
                        Text("\(a.enabledTools.count)")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .width(48)
                }
                .tableStyle(.inset)
                .contextMenu(forSelectionType: Agent.ID.self) { ids in
                    if let id = ids.first, let a = agents.first(where: { $0.id == id }) {
                        Button("设为当前") { store.setActiveAgent(id: a.id) }.disabled(a.id == activeID)
                        Button("编辑") { editingAgent = a }
                        Button("删除", role: .destructive) {
                            store.removeAgent(id: a.id); if selectedID == a.id { selectedID = nil }
                        }
                    }
                } primaryAction: { ids in
                    if let id = ids.first, let a = agents.first(where: { $0.id == id }) { editingAgent = a }
                }
                .overlay {
                    if agents.isEmpty {
                        Text("还没有智能体。点右上角「添加智能体」。")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.bottom, 16)
            }
        }
        .sheet(isPresented: $showingAdd) {
            AgentEditorSheet(registry: registry, skills: skills) { store.addAgent($0) }
        }
        .sheet(item: $editingAgent) { agent in
            AgentEditorSheet(editing: agent, registry: registry, skills: skills) { updated in
                store.updateAgent(id: agent.id) { a in
                    a.name = updated.name
                    a.icon = updated.icon
                    a.systemPrompt = updated.systemPrompt
                    a.enabledTools = updated.enabledTools
                    a.enabledSkills = updated.enabledSkills
                }
            }
        }
    }

    private func preview(_ a: Agent) -> String {
        let flat = a.systemPrompt.replacingOccurrences(of: "\n", with: " ").trimmed
        return flat.isEmpty ? "（无系统提示词）" : String(flat.prefix(80))
    }
}

// MARK: - Editor

private struct AgentEditorSheet: View {
    var editing: Agent?
    let registry: ToolRegistry
    let skills: SkillStore
    var onSave: (Agent) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: Agent
    @State private var capTab: CapabilityKind = .tools

    private static let iconChoices = [
        "sparkles", "chevron.left.forwardslash.chevron.right", "brain.head.profile",
        "text.bubble", "doc.text.magnifyingglass", "globe", "wand.and.stars",
        "terminal", "paintbrush.pointed", "graduationcap", "briefcase", "hammer",
    ]

    init(editing: Agent? = nil, registry: ToolRegistry, skills: SkillStore,
         onSave: @escaping (Agent) -> Void) {
        self.editing = editing
        self.registry = registry
        self.skills = skills
        self.onSave = onSave
        if let editing {
            _draft = State(initialValue: editing)
        } else {
            // New agents start with all built-in tools enabled; MCP / 技能 are opt-in.
            var a = Agent()
            a.enabledTools = Set(registry.all
                .filter { CapabilityKind.of($0.category) == .tools }
                .map { $0.spec.name })
            _draft = State(initialValue: a)
        }
    }

    private var canSave: Bool { !draft.name.trimmed.isEmpty }

    /// A selectable capability row, unifying tools and disk skills.
    private struct CapRow: Identifiable { let id: String; let title: String; let subtitle: String; let dangerous: Bool }

    private func rows(for kind: CapabilityKind) -> [CapRow] {
        if kind == .skills {
            return skills.skills.map { CapRow(id: $0.id, title: $0.displayName, subtitle: $0.id, dangerous: false) }
        }
        return registry.all
            .filter { CapabilityKind.of($0.category) == kind }
            .map { CapRow(id: $0.spec.name, title: $0.displayName, subtitle: $0.spec.name, dangerous: $0.isDangerous) }
    }

    private func isOn(_ kind: CapabilityKind, _ id: String) -> Bool {
        kind == .skills ? draft.enabledSkills.contains(id) : draft.enabledTools.contains(id)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(editing == nil ? "添加智能体" : "编辑智能体").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Name + icon
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text("名称").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
                        TextField("例如：编码助手、翻译官", text: $draft.name).textFieldStyle(.roundedBorder)
                    }
                    HStack(alignment: .top, spacing: 12) {
                        Text("图标").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
                            .padding(.top, 4)
                        iconPicker
                    }

                    // System prompt
                    VStack(alignment: .leading, spacing: 6) {
                        Text("系统提示词").font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $draft.systemPrompt)
                            .font(.system(.callout, design: .monospaced))
                            .frame(height: 150)
                            .overlay(alignment: .topLeading) {
                                if draft.systemPrompt.isEmpty {
                                    Text("描述这个智能体的身份、风格与规则…")
                                        .font(.system(.callout, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                        .padding(.top, 8).padding(.leading, 5)
                                        .allowsHitTesting(false)
                                }
                            }
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
                    }

                    // Capabilities — tabbed 工具 / MCP / 技能, full-width to match
                    // the prompt box above.
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("能力").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Text("共选 \(draft.enabledTools.count + draft.enabledSkills.count)")
                                .font(.caption2).foregroundStyle(.tertiary)
                        }
                        capabilityBox
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 18)
            }
            .scrollIndicators(.automatic)
            .background(ThinScrollers())

            Divider()
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    var a = draft
                    a.name = a.name.trimmed
                    onSave(a)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(!canSave)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
        }
        .frame(width: 620, height: 660)
    }

    private var iconPicker: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(34), spacing: 6), count: 8), spacing: 6) {
            ForEach(Self.iconChoices, id: \.self) { symbol in
                Button { draft.icon = symbol } label: {
                    Image(systemName: symbol)
                        .font(.system(size: 15))
                        .frame(width: 32, height: 30)
                        .background(draft.icon == symbol ? Color.accentColor.opacity(0.2) : Color.primary.opacity(0.05),
                                    in: RoundedRectangle(cornerRadius: 7))
                        .foregroundStyle(draft.icon == symbol ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var capabilityBox: some View {
        let items = rows(for: capTab)
        let ids = items.map(\.id)
        let allOn = !ids.isEmpty && ids.allSatisfy { isOn(capTab, $0) }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Picker("", selection: $capTab) {
                    ForEach(CapabilityKind.allCases) { Text($0.title).tag($0) }
                }
                .labelsHidden().pickerStyle(.segmented).fixedSize()
                Spacer()
                if !ids.isEmpty {
                    Button(allOn ? "全不选" : "全选") { setAll(capTab, ids, on: !allOn) }
                        .buttonStyle(.borderless).controlSize(.small)
                }
            }
            .padding(10)
            Divider()
            if items.isEmpty {
                Text(emptyHint(capTab))
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(items) { row in
                        Toggle(isOn: binding(capTab, row.id)) {
                            HStack(spacing: 6) {
                                Text(row.title)
                                Text(row.subtitle).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                                if row.dangerous {
                                    Image(systemName: "exclamationmark.triangle.fill")
                                        .font(.caption2).foregroundStyle(.orange)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                        .toggleStyle(.checkbox)
                    }
                }
                .padding(12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
    }

    private func setAll(_ kind: CapabilityKind, _ ids: [String], on: Bool) {
        for id in ids {
            if kind == .skills {
                if on { draft.enabledSkills.insert(id) } else { draft.enabledSkills.remove(id) }
            } else {
                if on { draft.enabledTools.insert(id) } else { draft.enabledTools.remove(id) }
            }
        }
    }

    private func emptyHint(_ kind: CapabilityKind) -> String {
        switch kind {
        case .tools:  return "暂无工具。"
        case .mcp:    return "未连接 MCP 工具。在「功能 → MCP」添加并连接服务器后，其工具会出现在这里。"
        case .skills: return "还没有技能。在「功能 → 技能」把技能放进 ~/.orbit/skills 并扫描后，会出现在这里。"
        }
    }

    private func binding(_ kind: CapabilityKind, _ id: String) -> Binding<Bool> {
        Binding(
            get: { isOn(kind, id) },
            set: { on in
                if kind == .skills {
                    if on { draft.enabledSkills.insert(id) } else { draft.enabledSkills.remove(id) }
                } else {
                    if on { draft.enabledTools.insert(id) } else { draft.enabledTools.remove(id) }
                }
            }
        )
    }
}

// MARK: - Thin scrollers

/// Forces the enclosing `NSScrollView` to the thin overlay scroller style, so the
/// editor doesn't show macOS's thick legacy scrollbar (which appears when the
/// system setting is "always show scroll bars").
private struct ThinScrollers: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async {
            var next = view.superview
            while let cur = next, !(cur is NSScrollView) { next = cur.superview }
            if let scroll = next as? NSScrollView {
                scroll.scrollerStyle = .overlay
                scroll.verticalScroller?.controlSize = .small
            }
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
