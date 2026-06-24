//  AddProviderSheet.swift
//  A modal editor for creating or editing a provider: name, Base URL, API Key.
//  The user can test the connection before saving. OpenAI-compatible only.

import SwiftUI

struct AddProviderSheet: View {
    /// Pass an existing provider to edit it; nil to create a new one.
    var editing: Provider?
    var onSave: (Provider) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var draft: Provider
    @State private var testStatus = ""
    @State private var testOK: Bool? = nil
    @State private var testing = false

    init(editing: Provider? = nil, onSave: @escaping (Provider) -> Void) {
        self.editing = editing
        self.onSave = onSave
        _draft = State(initialValue: editing ?? Provider(name: "OpenAI"))
    }

    private var isEditing: Bool { editing != nil }
    private var canSave: Bool { !draft.name.trimmed.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(isEditing ? "编辑服务商" : "添加服务商").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 6)

            Form {
                TextField("名称", text: $draft.name)
                    .textFieldStyle(.roundedBorder)
                TextField("Base URL", text: $draft.baseURL)
                    .textFieldStyle(.roundedBorder)
                RevealableSecureField(title: "API Key", text: $draft.apiKey)
            }
            .formStyle(.grouped)

            Divider()

            HStack(spacing: 10) {
                if !testStatus.isEmpty {
                    Image(systemName: testOK == true ? "checkmark.circle.fill"
                          : (testOK == false ? "xmark.circle.fill" : "circle.dashed"))
                        .foregroundStyle(testOK == true ? .green : (testOK == false ? .red : .secondary))
                    Text(testStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(testing ? "测试中…" : "测试连接") { runTest() }
                    .disabled(testing)
                Button("保存") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
        }
        .frame(width: 480, height: 360)
    }

    // MARK: - Actions

    private func runTest() {
        testing = true
        testStatus = ""
        testOK = nil
        let snapshot = draft
        Task { @MainActor in
            defer { testing = false }
            do {
                testStatus = try await ProviderAPI.test(snapshot)
                testOK = true
            } catch {
                testStatus = (error as? ProviderAPIError)?.errorDescription
                    ?? error.localizedDescription
                testOK = false
            }
        }
    }

    private func save() {
        var provider = draft
        provider.name = provider.name.trimmed
        provider.baseURL = provider.baseURL.trimmed
        onSave(provider)
        dismiss()
    }
}
