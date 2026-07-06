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
    // Chat feature flags — user-editable, seeded from upstream / catalog. Ignored
    // for non-chat rows (ASR/image/video), which persist `.none`.
    var multimodal: Bool
    var thinking: Bool
    var toolCalling: Bool
    /// Hand-added (not from /models): its id + capability are editable inline.
    var manual: Bool = false

    var abilities: LLMCapabilities {
        LLMCapabilities(multimodal: multimodal, thinking: thinking, toolCalling: toolCalling)
    }

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
        .frame(width: 760, height: 680)
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
            // No manual 鉴权 control: the auth scheme is decided entirely by the
            // 渠道商 type (applyAdapter stamps the adapter's `auth`). Different
            // channels auto-adapt once you enter the key.
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
                Button { addManualModel() } label: {
                    Label("手动添加", systemImage: "plus")
                }
                .controlSize(.small)
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
                Text("点「获取模型列表」加载该渠道的上游模型；若 /models 没列出你要的模型（如某些图片模型），用「手动添加」填模型 id 并选能力。勾选要用的、设费用、标能力即可。")
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
        // One tidy left-to-right row: checkbox · name (flexes to fill) · feature
        // flags · pricing mode · pricing fields. Fixed-width columns keep the
        // flags / pricing aligned across every row; the name column absorbs the
        // slack so there's no empty gutter on the right.
        return HStack(spacing: 12) {
            Toggle("", isOn: entry.include).labelsHidden().toggleStyle(.checkbox)

            if e.manual {
                // Hand-added: id + capability are editable inline.
                HStack(spacing: 8) {
                    TextField("模型 id，如 gpt-image-2", text: entry.model)
                        .textFieldStyle(.roundedBorder).font(.callout.monospaced())
                    Picker("", selection: entry.capability) {
                        ForEach(manualCapabilities, id: \.self) { Text($0.displayName).tag($0) }
                    }
                    .labelsHidden().fixedSize()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    Text(e.model).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                    Text(e.capability.displayName).font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Feature flags occupy a fixed slot (empty for non-chat) so the
            // pricing columns line up whatever the row's capability.
            HStack(spacing: 5) {
                if e.capability == .chat {
                    abilityChip("多模态", systemImage: "photo", isOn: entry.multimodal)
                    abilityChip("思考", systemImage: "brain", isOn: entry.thinking)
                    abilityChip("工具", systemImage: "wrench.and.screwdriver", isOn: entry.toolCalling)
                }
            }
            .frame(width: 190, alignment: .leading)
            .disabled(!e.include)

            Picker("", selection: entry.mode) {
                ForEach(PricingMode.allCases) { Text($0.label).tag($0) }
            }
            .labelsHidden().frame(width: 84).disabled(!e.include)

            pricingFields(entry).disabled(!e.include)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .opacity(e.include ? 1 : 0.5)
    }

    /// A tappable capability chip; accent-filled when the flag is on.
    private func abilityChip(_ title: String, systemImage: String, isOn: Binding<Bool>) -> some View {
        let on = isOn.wrappedValue
        return Button { isOn.wrappedValue.toggle() } label: {
            HStack(spacing: 3) {
                Image(systemName: systemImage).imageScale(.small)
                Text(title)
            }
            .font(.caption2)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(on ? Color.accentColor : Color.secondary)
            .background(
                Capsule(style: .continuous)
                    .fill(on ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.10))
            )
        }
        .buttonStyle(.plain)
        .help("\(title)：点按切换支持 / 不支持")
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
            applyFetched(adapter.catalog.map {
                ProviderAPI.FetchedModel(id: $0.id, displayName: $0.displayName, abilities: $0.abilities)
            })
            if entries.isEmpty { fetchError = "该渠道商没有内置模型目录。" }
            return
        }
        fetching = true
        let snapshot = draft
        Task { @MainActor in
            defer { fetching = false }
            do {
                let models = try await ProviderAPI.fetchModels(snapshot)
                applyFetched(models)
                if models.isEmpty { fetchError = "该渠道商没有返回任何模型。" }
            } catch {
                fetchError = (error as? ProviderAPIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// Merge fetched ids into the editable list: keep existing rows (with their
    /// pricing), add new ones, and only surface models the channel's protocols
    /// can run (chat / ASR). Chat first, then ASR, alphabetically.
    private func applyFetched(_ fetched: [ProviderAPI.FetchedModel]) {
        // One base URL often serves more than chat — image / video / ASR models
        // too. Auto-provision a service for each capability found among the fetched
        // models (using the adapter's wire for it) so those models aren't silently
        // dropped by the capability filter below (e.g. an image model on an
        // OpenAI-compatible aggregator that was seeded with only a chat service).
        let foundCaps = Set(fetched.map {
            adapter.card(forModelID: $0.id)?.capability ?? ChannelAdapter.inferCapability($0.id)
        })
        for cap in foundCaps where !draft.services.contains(where: { $0.capability == cap }) {
            if let wire = adapter.wire(for: cap) {
                draft.services.append(Service(wire: wire))
            }
        }
        let usable = Set(draft.services.map(\.capability))
        let currency = Self.defaultCurrency(for: draft.adapterID)
        var byModel = Dictionary(entries.map { ($0.model, $0) }, uniquingKeysWith: { a, _ in a })
        var result: [ChannelModelDraft] = []
        for f in fetched {
            let card = adapter.card(forModelID: f.id)
            let cap = card?.capability ?? ChannelAdapter.inferCapability(f.id)
            guard usable.contains(cap) else { continue }
            if let keep = byModel.removeValue(forKey: f.id) {
                result.append(keep)   // keep the user's row (flags + pricing intact)
            } else {
                // Feature flags: upstream-declared wins; else the shipped catalog
                // card (curated, not a name guess); else all-off for the user to set.
                let ab = f.abilities ?? card?.abilities ?? .none
                result.append(ChannelModelDraft(
                    id: UUID().uuidString, existingID: nil, model: f.id,
                    name: card?.displayName ?? f.displayName ?? f.id,
                    capability: cap, include: true, mode: .none,
                    inputStr: "", outputStr: "", perCallStr: "", perMinuteStr: "", currency: currency,
                    multimodal: ab.multimodal, thinking: ab.thinking, toolCalling: ab.toolCalling))
            }
        }
        // Preserve any prior rows not present upstream (manually kept).
        result.append(contentsOf: byModel.values)
        entries = result.sorted {
            ($0.capability == .asr ? 1 : 0, $0.model) < ($1.capability == .asr ? 1 : 0, $1.model)
        }
    }

    /// Capabilities this adapter can actually run (has a wire for) — the choices
    /// offered when hand-adding a model. Chat always first.
    private var manualCapabilities: [Capability] {
        let caps = Set(adapter.wires.keys).union([.chat])
        return caps.sorted { ($0 == .chat ? 0 : 1, $0.displayName) < ($1 == .chat ? 0 : 1, $1.displayName) }
    }

    /// Append a blank, editable row for a model `/models` didn't list.
    private func addManualModel() {
        fetchError = nil
        entries.insert(ChannelModelDraft(
            id: UUID().uuidString, existingID: nil, model: "", name: "",
            capability: .chat, include: true, mode: .none,
            inputStr: "", outputStr: "", perCallStr: "", perMinuteStr: "",
            currency: Self.defaultCurrency(for: draft.adapterID),
            multimodal: false, thinking: false, toolCalling: false, manual: true),
            at: 0)
    }

    private func save() {
        var provider = draft
        provider.name = provider.name.trimmed
        provider.baseURL = provider.baseURL.trimmed
        // Ensure a service exists for every included (non-empty) model's capability
        // — covers hand-added models whose capability the seeded catalog lacked.
        let includedCaps = Set(entries.filter { $0.include && !$0.model.trimmed.isEmpty }.map(\.capability))
        for cap in includedCaps where !provider.services.contains(where: { $0.capability == cap }) {
            if let wire = adapter.wire(for: cap) { provider.services.append(Service(wire: wire)) }
        }
        let models: [ModelConfig] = entries.filter { $0.include && !$0.model.trimmed.isEmpty }.compactMap { e in
            guard let svc = provider.services.first(where: { $0.capability == e.capability }) else { return nil }
            return ModelConfig(
                id: e.existingID ?? UUID().uuidString,
                providerID: provider.id,
                serviceID: svc.id,
                name: e.name.trimmed.isEmpty ? e.model.trimmed : e.name,
                model: e.model.trimmed,
                llmCapabilities: e.capability == .chat ? e.abilities : .none,
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
        // Explicit stored flags win; for models saved before flags were editable
        // (all `.none`), fall back to the catalog card so known models pre-fill.
        let stored = m.llmCapabilities
        let ab = stored != .none
            ? stored
            : (ChannelAdapter.byID(provider.adapterID)?.card(forModelID: m.model)?.abilities ?? .none)
        return ChannelModelDraft(
            id: m.id, existingID: m.id, model: m.model, name: m.name, capability: cap,
            include: true, mode: mode,
            inputStr: s(p?.inputPer1M), outputStr: s(p?.outputPer1M),
            perCallStr: s(p?.perCall), perMinuteStr: s(p?.perAudioMinute),
            currency: p?.currency ?? fallbackCurrency,
            multimodal: ab.multimodal, thinking: ab.thinking, toolCalling: ab.toolCalling)
    }
}
