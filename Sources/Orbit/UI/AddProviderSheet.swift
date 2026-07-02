//  AddProviderSheet.swift
//  Adapter-driven "add channel (渠道商)" editor. Pick a channel adapter (a select),
//  fill the key (+ base URL for self-hosted), then 获取模型列表 → the channel's
//  upstream models load into an editable list where each model can be included
//  and priced. Pricing modes mirror an API relay (中转站): 按 Token (input/output
//  per 1M), 按次 (flat per call), 按分钟 (audio, for ASR), or 不计费. Protocols are
//  shown read-only, fixed by the adapter. Saved models + prices are synced to the
//  channel — there is no separate 模型 page.

import SwiftUI

/// How a model is billed, driving the pricing fields shown per row.
enum PricingMode: String, CaseIterable, Identifiable {
    case none, token, perCall, perMinute
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none:      return "不计费"
        case .token:     return "按 Token"
        case .perCall:   return "按次"
        case .perMinute: return "按分钟"
        }
    }
}

/// One editable row in the channel's model list.
struct ChannelModelDraft: Identifiable {
    let id: String
    var existingID: String?     // reuse the ModelConfig id so selections survive
    var model: String
    var name: String
    var capability: Capability
    var include: Bool
    var mode: PricingMode
    var inputStr: String
    var outputStr: String
    var perCallStr: String
    var perMinuteStr: String
    var currency: String

    /// Build the persisted price from the entered fields (nil when unpriced).
    func pricing() -> ModelPricing? {
        let p: ModelPricing
        switch mode {
        case .none:      return nil
        case .token:     p = ModelPricing(inputPer1M: Double(inputStr.trimmed), outputPer1M: Double(outputStr.trimmed), currency: currency)
        case .perCall:   p = ModelPricing(perCall: Double(perCallStr.trimmed), currency: currency)
        case .perMinute: p = ModelPricing(perAudioMinute: Double(perMinuteStr.trimmed), currency: currency)
        }
        return p.isEmpty ? nil : p
    }
}

struct AddProviderSheet: View {
    var editing: Provider?
    var existingModels: [ModelConfig]
    var onSave: (Provider, [ModelConfig]) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var draft: Provider
    @State private var entries: [ChannelModelDraft]
    @State private var testStatus = ""
    @State private var testOK: Bool? = nil
    @State private var testing = false
    @State private var fetching = false
    @State private var fetchError: String?

    private let labelWidth: CGFloat = 84

    init(editing: Provider? = nil,
         existingModels: [ModelConfig] = [],
         onSave: @escaping (Provider, [ModelConfig]) -> Void) {
        self.editing = editing
        self.existingModels = existingModels
        self.onSave = onSave
        let prov = editing ?? ChannelAdapter.openAI.makeProvider(name: "")
        _draft = State(initialValue: prov)
        let currency = Self.defaultCurrency(for: prov.adapterID)
        _entries = State(initialValue: existingModels.map {
            Self.draft(from: $0, provider: prov, fallbackCurrency: currency)
        })
    }

    private var isEditing: Bool { editing != nil }
    private var canSave: Bool { !draft.name.trimmed.isEmpty }
    private var adapter: ChannelAdapter { ChannelAdapter.byID(draft.adapterID) ?? .custom }
    private var modelsPreview: String { draft.modelsEndpoint?.absoluteString ?? "（Base URL 无效）" }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(isEditing ? "编辑渠道商" : "添加渠道商").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    fields
                    Divider()
                    modelsEditor
                }
                .padding(.horizontal, 20).padding(.vertical, 18)
            }

            Divider()
            footer
        }
        .frame(width: 720, height: 680)
    }

    // MARK: - Fields

    private var fields: some View {
        VStack(alignment: .leading, spacing: 14) {
            labeledRow("渠道商") {
                Picker("", selection: Binding(
                    get: { draft.adapterID },
                    set: { id in if let a = ChannelAdapter.byID(id) { applyAdapter(a) } }
                )) {
                    ForEach(ChannelAdapter.all) { a in Text(a.displayName).tag(a.id) }
                }
                .labelsHidden().pickerStyle(.menu).fixedSize()
            }
            labeledRow("名称") {
                TextField("例如：OpenAI、我的 New API", text: $draft.name).textFieldStyle(.roundedBorder)
            }
            labeledRow("Base URL") {
                VStack(alignment: .leading, spacing: 5) {
                    if adapter.baseURLEditable {
                        TextField(adapter.id == "newapi" ? "https://你的域名/v1" : Provider.openAIBase, text: $draft.baseURL)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        Text(draft.baseURL.isEmpty ? "—" : draft.baseURL)
                            .font(.callout.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.turn.down.right")
                        Text("列表/测试：\(modelsPreview)").textSelection(.enabled)
                    }
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
            }
            if adapter.isCustom {
                labeledRow("鉴权") {
                    Picker("", selection: $draft.auth) {
                        ForEach(AuthScheme.allCases) { Text($0.displayName).tag($0) }
                    }
                    .pickerStyle(.menu).labelsHidden().fixedSize()
                }
            }
            labeledRow("API Key") {
                RevealableSecureField(title: draft.auth == .anthropic ? "sk-ant-…" : "sk-…", text: $draft.apiKey)
            }
        }
    }

    @ViewBuilder
    private func labeledRow<Field: View>(_ label: String, @ViewBuilder _ field: () -> Field) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).frame(width: labelWidth, alignment: .leading).foregroundStyle(.secondary)
            field()
        }
    }

    private func applyAdapter(_ a: ChannelAdapter) {
        let old = ChannelAdapter.byID(draft.adapterID)
        if draft.name.trimmed.isEmpty || draft.name == old?.displayName { draft.name = a.displayName }
        draft.adapterID = a.id
        draft.auth = a.auth
        draft.services = a.seededServices()
        if !a.baseURLEditable { draft.baseURL = a.defaultBaseURL }
        else if draft.baseURL == old?.defaultBaseURL { draft.baseURL = a.defaultBaseURL }
        entries = []; fetchError = nil; testStatus = ""; testOK = nil
    }

    // MARK: - Models + pricing editor

    private var includedCount: Int { entries.filter(\.include).count }

    private var modelsEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("模型与费用").font(.subheadline.weight(.semibold))
                if !entries.isEmpty {
                    Text("已选 \(includedCount)/\(entries.count)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if !entries.isEmpty {
                    Button(allIncluded ? "全不选" : "全选") { toggleAll() }
                        .buttonStyle(.borderless).controlSize(.small)
                }
                Button { fetchModels() } label: {
                    Label(fetching ? "获取中…" : "获取模型列表", systemImage: "arrow.down.circle")
                }
                .controlSize(.small).disabled(fetching)
            }

            if let err = fetchError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }

            if entries.isEmpty {
                Text("点「获取模型列表」加载该渠道的上游模型，勾选要用的并为其设置费用（按 Token / 按次 / 按分钟）。")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            } else {
                VStack(spacing: 0) {
                    ForEach($entries) { $entry in
                        modelRow($entry)
                        Divider()
                    }
                }
                .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private func modelRow(_ entry: Binding<ChannelModelDraft>) -> some View {
        let e = entry.wrappedValue
        return HStack(spacing: 10) {
            Toggle("", isOn: entry.include).labelsHidden().toggleStyle(.checkbox)
            VStack(alignment: .leading, spacing: 1) {
                Text(e.model).font(.callout.monospaced()).lineLimit(1)
                Text(e.capability.displayName).font(.caption2).foregroundStyle(.secondary)
            }
            .frame(width: 220, alignment: .leading)

            Picker("", selection: entry.mode) {
                ForEach(PricingMode.allCases) { Text($0.label).tag($0) }
            }
            .labelsHidden().fixedSize().disabled(!e.include)

            pricingFields(entry).disabled(!e.include)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .opacity(e.include ? 1 : 0.5)
    }

    @ViewBuilder
    private func pricingFields(_ entry: Binding<ChannelModelDraft>) -> some View {
        switch entry.wrappedValue.mode {
        case .none:
            EmptyView()
        case .token:
            numField("输入/M", entry.inputStr)
            numField("输出/M", entry.outputStr)
            currencyPicker(entry)
        case .perCall:
            numField("每次", entry.perCallStr)
            currencyPicker(entry)
        case .perMinute:
            numField("每分钟", entry.perMinuteStr)
            currencyPicker(entry)
        }
    }

    private func numField(_ placeholder: String, _ text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.roundedBorder).frame(width: 76).font(.caption.monospaced())
    }

    private func currencyPicker(_ entry: Binding<ChannelModelDraft>) -> some View {
        Picker("", selection: entry.currency) {
            Text("USD").tag("USD"); Text("CNY").tag("CNY")
        }
        .labelsHidden().fixedSize()
    }

    private var allIncluded: Bool { !entries.isEmpty && entries.allSatisfy(\.include) }
    private func toggleAll() {
        let target = !allIncluded
        for i in entries.indices { entries[i].include = target }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 10) {
            if !testStatus.isEmpty {
                Image(systemName: testOK == true ? "checkmark.circle.fill"
                      : (testOK == false ? "xmark.circle.fill" : "circle.dashed"))
                    .foregroundStyle(testOK == true ? .green : (testOK == false ? .red : .secondary))
                Text(testStatus).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
            Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
            Button(testing ? "测试中…" : "测试连接") { runTest() }.disabled(testing)
            Button("保存") { save() }.keyboardShortcut(.defaultAction).disabled(!canSave)
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    // MARK: - Actions

    private func runTest() {
        testing = true; testStatus = ""; testOK = nil
        let snapshot = draft
        Task { @MainActor in
            defer { testing = false }
            do { testStatus = try await ProviderAPI.test(snapshot); testOK = true }
            catch {
                testStatus = (error as? ProviderAPIError)?.errorDescription ?? error.localizedDescription
                testOK = false
            }
        }
    }

    private func fetchModels() {
        fetchError = nil
        if adapter.modelSource == .catalog {
            applyFetched(adapter.catalog.map(\.id))
            if entries.isEmpty { fetchError = "该渠道商没有内置模型目录。" }
            return
        }
        fetching = true
        let snapshot = draft
        Task { @MainActor in
            defer { fetching = false }
            do {
                let ids = try await ProviderAPI.fetchModels(snapshot)
                applyFetched(ids)
                if ids.isEmpty { fetchError = "该渠道商没有返回任何模型。" }
            } catch {
                fetchError = (error as? ProviderAPIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// Merge fetched ids into the editable list: keep existing rows (with their
    /// pricing), add new ones, and only surface models the channel's protocols
    /// can run (chat / ASR). Chat first, then ASR, alphabetically.
    private func applyFetched(_ ids: [String]) {
        let usable = Set(draft.services.map(\.capability))
        let currency = Self.defaultCurrency(for: draft.adapterID)
        var byModel = Dictionary(entries.map { ($0.model, $0) }, uniquingKeysWith: { a, _ in a })
        var result: [ChannelModelDraft] = []
        for id in ids {
            let cap = adapter.card(forModelID: id)?.capability ?? ChannelAdapter.inferCapability(id)
            guard usable.contains(cap) else { continue }
            if let keep = byModel.removeValue(forKey: id) {
                result.append(keep)
            } else {
                result.append(ChannelModelDraft(
                    id: UUID().uuidString, existingID: nil, model: id,
                    name: adapter.card(forModelID: id)?.displayName ?? id,
                    capability: cap, include: true, mode: .none,
                    inputStr: "", outputStr: "", perCallStr: "", perMinuteStr: "", currency: currency))
            }
        }
        // Preserve any prior rows not present upstream (manually kept).
        result.append(contentsOf: byModel.values)
        entries = result.sorted {
            ($0.capability == .asr ? 1 : 0, $0.model) < ($1.capability == .asr ? 1 : 0, $1.model)
        }
    }

    private func save() {
        var provider = draft
        provider.name = provider.name.trimmed
        provider.baseURL = provider.baseURL.trimmed
        let models: [ModelConfig] = entries.filter(\.include).compactMap { e in
            guard let svc = provider.services.first(where: { $0.capability == e.capability }) else { return nil }
            return ModelConfig(
                id: e.existingID ?? UUID().uuidString,
                providerID: provider.id,
                serviceID: svc.id,
                name: e.name.trimmed.isEmpty ? e.model : e.name,
                model: e.model,
                pricingOverride: e.pricing())
        }
        onSave(provider, models)
        dismiss()
    }

    // MARK: - Helpers

    private static func defaultCurrency(for adapterID: String) -> String {
        ["mimo", "deepseek", "moonshot", "zhipu"].contains(adapterID) ? "CNY" : "USD"
    }

    private static func draft(from m: ModelConfig, provider: Provider, fallbackCurrency: String) -> ChannelModelDraft {
        let cap = provider.services.first { $0.id == m.serviceID }?.capability
            ?? ChannelAdapter.inferCapability(m.model)
        let p = m.pricingOverride
        let mode: PricingMode = {
            guard let p, !p.isEmpty else { return .none }
            if p.perAudioMinute != nil { return .perMinute }
            if p.perCall != nil { return .perCall }
            return .token
        }()
        func s(_ v: Double?) -> String { v.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? "" }
        return ChannelModelDraft(
            id: m.id, existingID: m.id, model: m.model, name: m.name, capability: cap,
            include: true, mode: mode,
            inputStr: s(p?.inputPer1M), outputStr: s(p?.outputPer1M),
            perCallStr: s(p?.perCall), perMinuteStr: s(p?.perAudioMinute),
            currency: p?.currency ?? fallbackCurrency)
    }
}
