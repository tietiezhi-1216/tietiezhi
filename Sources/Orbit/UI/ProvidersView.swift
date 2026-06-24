//  ProvidersView.swift
//  Manage OpenAI-compatible providers as a table: name, Base URL, masked API
//  Key. Add / edit happen in a modal sheet (SwiftUI Table is read-only).

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

    var body: some View {
        PageScaffold(title: "服务商") {
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
                    Label("添加服务商", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            Table(store.settings.providers, selection: $selectedID) {
                TableColumn("名称", value: \.name)
                TableColumn("Base URL", value: \.baseURL)
                TableColumn("API Key") { provider in
                    Text(provider.apiKey.isEmpty ? "—" : "••••••••")
                        .foregroundStyle(.secondary)
                }
            }
            .contextMenu(forSelectionType: Provider.ID.self) { ids in
                if let id = ids.first,
                   let provider = store.settings.providers.first(where: { $0.id == id }) {
                    Button("编辑") { editingProvider = provider }
                    Button("删除", role: .destructive) {
                        store.removeProvider(id: id)
                        if selectedID == id { selectedID = nil }
                    }
                }
            }
            .overlay {
                if store.settings.providers.isEmpty {
                    Text("还没有服务商，点右上角「添加服务商」开始。")
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 12)
        }
        .sheet(isPresented: $showingAdd) {
            AddProviderSheet { newProvider in
                store.addProvider(newProvider)
            }
        }
        .sheet(item: $editingProvider) { provider in
            AddProviderSheet(editing: provider) { updated in
                store.updateProvider(id: provider.id) { existing in
                    existing.name = updated.name
                    existing.baseURL = updated.baseURL
                    existing.apiKey = updated.apiKey
                }
            }
        }
    }
}
