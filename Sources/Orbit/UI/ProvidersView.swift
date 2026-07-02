//  ProvidersView.swift
//  Manage providers as a SwiftUI `Table`: name, protocol, Base URL, masked API
//  Key. Rendered with the bordered table style (a bezeled box, no row stripes).
//  Columns carry no fixed width, so they auto-size and spread to fill. Add /
//  edit happen in a modal sheet (SwiftUI Table is read-only).

import SwiftUI

struct ProvidersView: View {
    @EnvironmentObject var store: SettingsStore

    @State private var selectedID: Provider.ID?
    @State private var showingAdd = false
    @State private var editingProvider: Provider?

    private var selectedProvider: Provider? {
        guard let id = selectedID else { return nil }
        return store.settings.providers.first { $0.id == id }
    }

    private func modelCount(_ provider: Provider) -> Int {
        store.settings.models.filter { $0.providerID == provider.id }.count
    }

    private func models(for provider: Provider) -> [ModelConfig] {
        store.settings.models.filter { $0.providerID == provider.id }
    }

    var body: some View {
        PageScaffold(title: "渠道商", maxWidth: .infinity) {
            HStack(spacing: 8) {
                Button {
                    if let p = selectedProvider { editingProvider = p }
                } label: {
                    Label("编辑", systemImage: "pencil")
                }
                .disabled(selectedProvider == nil)

                Button {
                    if let id = selectedID {
                        store.removeProvider(id: id)
                        selectedID = nil
                    }
                } label: {
                    Label("删除", systemImage: "trash")
                }
                .disabled(selectedID == nil)

                Button { showingAdd = true } label: {
                    Label("添加渠道商", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            Table(store.settings.providers, selection: $selectedID) {
                TableColumn("名称", value: \.name)
                TableColumn("模型") { provider in
                    Text("\(modelCount(provider))").foregroundStyle(.secondary)
                }
                TableColumn("Base URL", value: \.baseURL)
                TableColumn("API Key") { provider in
                    Text(provider.apiKey.isEmpty ? "—" : "••••••••")
                        .foregroundStyle(.secondary)
                }
            }
            .tableStyle(.inset)
            .contextMenu(forSelectionType: Provider.ID.self) { ids in
                if let id = ids.first,
                   let provider = store.settings.providers.first(where: { $0.id == id }) {
                    Button("编辑") { editingProvider = provider }
                    Button("删除", role: .destructive) {
                        store.removeProvider(id: id)
                        if selectedID == id { selectedID = nil }
                    }
                }
            } primaryAction: { ids in
                if let id = ids.first,
                   let provider = store.settings.providers.first(where: { $0.id == id }) {
                    editingProvider = provider
                }
            }
            .overlay {
                if store.settings.providers.isEmpty {
                    Text("还没有渠道商,点右上角「添加渠道商」开始。")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.bottom, 16)
        }
        .sheet(isPresented: $showingAdd) {
            AddProviderSheet { newProvider, models in
                store.addProvider(newProvider)
                store.syncModels(providerID: newProvider.id, models: models)
            }
        }
        .sheet(item: $editingProvider) { provider in
            AddProviderSheet(editing: provider, existingModels: models(for: provider)) { updated, models in
                store.updateProvider(id: provider.id) { existing in
                    existing.name = updated.name
                    existing.baseURL = updated.baseURL
                    existing.apiKey = updated.apiKey
                    existing.auth = updated.auth
                    existing.services = updated.services
                    existing.adapterID = updated.adapterID
                }
                store.syncModels(providerID: provider.id, models: models)
            }
        }
    }
}

