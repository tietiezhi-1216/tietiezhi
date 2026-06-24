//  SettingsStore.swift
//  Loads/saves the `Settings` document as pretty JSON under Application Support
//  and publishes it for SwiftUI. Writes are debounced so editing a text field
//  doesn't hit the disk on every keystroke.

import Foundation
import Combine

final class SettingsStore: ObservableObject {
    @Published var settings: Settings {
        didSet { scheduleSave() }
    }

    /// Bumped whenever the active hotkey changes, so the hotkey monitor can
    /// re-read it cheaply.
    let hotkeyDidChange = PassthroughSubject<String, Never>()

    private let fileURL: URL
    private var saveWorkItem: DispatchWorkItem?
    private var lastHotkey: String

    init() {
        let dir = SettingsStore.configDirectory()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("config.json")

        var loaded = SettingsStore.load(from: fileURL) ?? .defaults
        SettingsStore.migrate(&loaded)
        settings = loaded
        lastHotkey = loaded.hotkey
    }

    /// One-time cleanups for configs written by older builds. Currently: drop
    /// providers with an empty Base URL — the signature of the removed 火山引擎
    /// entry — and detach any models / active selections that referenced them.
    private static func migrate(_ s: inout Settings) {
        let before = s.providers.count
        s.providers.removeAll { $0.baseURL.trimmingCharacters(in: .whitespaces).isEmpty }
        guard s.providers.count != before else { return }
        let ids = Set(s.providers.map(\.id))
        s.models.removeAll { !ids.contains($0.providerID) }
        if let a = s.asrModelID, !s.models.contains(where: { $0.id == a }) { s.asrModelID = nil }
        if let l = s.llmModelID, !s.models.contains(where: { $0.id == l }) { s.llmModelID = nil }
    }

    // MARK: Paths

    /// `~/Library/Application Support/com.orbit.app/`
    static func configDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("com.orbit.app", isDirectory: true)
    }

    // MARK: Persistence

    private static func load(from url: URL) -> Settings? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Settings.self, from: data)
    }

    private func scheduleSave() {
        // Surface hotkey changes immediately (the monitor needs them live).
        if settings.hotkey != lastHotkey {
            lastHotkey = settings.hotkey
            hotkeyDidChange.send(settings.hotkey)
        }
        saveWorkItem?.cancel()
        let snapshot = settings
        let item = DispatchWorkItem { [fileURL] in
            SettingsStore.write(snapshot, to: fileURL)
        }
        saveWorkItem = item
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    /// Force an immediate write (e.g. on app termination).
    func flush() {
        saveWorkItem?.cancel()
        SettingsStore.write(settings, to: fileURL)
    }

    private static func write(_ settings: Settings, to url: URL) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(settings) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // MARK: Mutating helpers (keep view code declarative)

    func addProvider(_ provider: Provider) {
        settings.providers.append(provider)
    }

    func removeProvider(id: String) {
        settings.providers.removeAll { $0.id == id }
        // Drop models that referenced it, and clear active selections if orphaned.
        settings.models.removeAll { $0.providerID == id }
        if let asr = settings.asrModelID, settings.models.first(where: { $0.id == asr }) == nil {
            settings.asrModelID = nil
        }
        if let llm = settings.llmModelID, settings.models.first(where: { $0.id == llm }) == nil {
            settings.llmModelID = nil
        }
    }

    func updateProvider(id: String, _ mutate: (inout Provider) -> Void) {
        guard let i = settings.providers.firstIndex(where: { $0.id == id }) else { return }
        mutate(&settings.providers[i])
    }

    func addModel(_ model: ModelConfig) {
        settings.models.append(model)
    }

    func removeModel(id: String) {
        settings.models.removeAll { $0.id == id }
        if settings.asrModelID == id { settings.asrModelID = nil }
        if settings.llmModelID == id { settings.llmModelID = nil }
    }

    func updateModel(id: String, _ mutate: (inout ModelConfig) -> Void) {
        guard let i = settings.models.firstIndex(where: { $0.id == id }) else { return }
        mutate(&settings.models[i])
    }

    func addTemplate(_ template: PromptTemplate) {
        settings.templates.append(template)
    }

    func removeTemplate(id: String) {
        settings.templates.removeAll { $0.id == id }
        if settings.activeTemplateID == id { settings.activeTemplateID = nil }
    }

    func updateTemplate(id: String, _ mutate: (inout PromptTemplate) -> Void) {
        guard let i = settings.templates.firstIndex(where: { $0.id == id }) else { return }
        mutate(&settings.templates[i])
    }
}
