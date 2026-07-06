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

    /// One-time cleanups for configs written by older builds:
    ///  1. Drop providers with an empty Base URL (the signature of the removed
    ///     火山引擎 entry) and detach any models / selections that referenced them.
    ///  2. Backfill each model's `serviceID` by matching its legacy role
    ///     (`kind: asr | llm`) to one of its provider's services. The provider
    ///     decoder already seeded a chat service with the correct wire (chat /
    ///     responses / anthropic) from the legacy `api`, so an old Responses or
    ///     Anthropic model lands on the right interface — no behaviour change.
    private static func migrate(_ s: inout Settings) {
        // (1) Empty-base-URL cleanup.
        let before = s.providers.count
        s.providers.removeAll { $0.baseURL.trimmingCharacters(in: .whitespaces).isEmpty }
        if s.providers.count != before {
            let ids = Set(s.providers.map(\.id))
            s.models.removeAll { !ids.contains($0.providerID) }
        }

        // (2) Backfill serviceID for models that predate the service catalog.
        for i in s.models.indices where s.models[i].serviceID == nil {
            guard let provider = s.provider(id: s.models[i].providerID) else { continue }
            let wantCap = s.models[i].legacyKind?.capability ?? .chat
            // Prefer a service of the matching capability; fall back to the first
            // service so the model still resolves rather than silently breaking.
            let match = provider.services.first { $0.capability == wantCap }
                ?? provider.services.first
            s.models[i].serviceID = match?.id
        }

        // Clear any active selections left dangling by the cleanup above, or
        // pointing at the wrong service class.
        if s.asrModel == nil { s.asrModelID = nil }
        if s.llmModel == nil { s.llmModelID = nil }
    }

    // MARK: Paths

    /// `~/.orbit/` — one inspectable home for all Orbit data (config, database,
    /// skills, generated media), alongside the skills folder.
    static func configDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".orbit", isDirectory: true)
    }

    /// The pre-consolidation location, kept only for the one-time migration.
    private static var legacyDirectory: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("com.orbit.app", isDirectory: true)
    }

    /// Move Orbit's data from `~/Library/Application Support/com.orbit.app/` to
    /// `~/.orbit/` once. Copies (never deletes) each item that isn't already in
    /// the new home, so the old files remain as a safety net. Idempotent — call
    /// at startup before any store loads.
    static func migrateStorageLocationIfNeeded() {
        let fm = FileManager.default
        let new = configDirectory()
        guard let old = legacyDirectory, fm.fileExists(atPath: old.path) else { return }
        try? fm.createDirectory(at: new, withIntermediateDirectories: true)
        guard let items = try? fm.contentsOfDirectory(at: old, includingPropertiesForKeys: nil) else { return }
        for item in items {
            let dest = new.appendingPathComponent(item.lastPathComponent)
            if !fm.fileExists(atPath: dest.path) {
                try? fm.copyItem(at: item, to: dest)
            }
        }
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

    /// Replace a channel's model set with the models chosen (and priced) in the
    /// channel editor. Existing model ids are reused by the editor for models
    /// that stay, so active ASR/LLM selections survive; anything dropped clears a
    /// dangling selection.
    func syncModels(providerID: String, models: [ModelConfig]) {
        settings.models.removeAll { $0.providerID == providerID }
        settings.models.append(contentsOf: models)
        if let asr = settings.asrModelID, !settings.models.contains(where: { $0.id == asr }) {
            settings.asrModelID = nil
        }
        if let llm = settings.llmModelID, !settings.models.contains(where: { $0.id == llm }) {
            settings.llmModelID = nil
        }
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

    // MARK: Shortcuts

    func addShortcut(_ shortcut: ActionShortcut) {
        settings.shortcuts.append(shortcut)
    }

    func removeShortcut(id: String) {
        settings.shortcuts.removeAll { $0.id == id }
    }

    func updateShortcut(id: String, _ mutate: (inout ActionShortcut) -> Void) {
        guard let i = settings.shortcuts.firstIndex(where: { $0.id == id }) else { return }
        mutate(&settings.shortcuts[i])
    }

    // MARK: Agents

    func addAgent(_ agent: Agent) {
        settings.agents.append(agent)
        if settings.activeAgentID == nil { settings.activeAgentID = agent.id }
    }

    func removeAgent(id: String) {
        settings.agents.removeAll { $0.id == id }
        if settings.activeAgentID == id { settings.activeAgentID = settings.agents.first?.id }
    }

    func updateAgent(id: String, _ mutate: (inout Agent) -> Void) {
        guard let i = settings.agents.firstIndex(where: { $0.id == id }) else { return }
        mutate(&settings.agents[i])
    }

    func setActiveAgent(id: String) {
        settings.activeAgentID = id
    }

    // MARK: Tool root directories (file / command tool whitelist)

    func addToolRootDirectory(_ path: String) {
        let p = path.trimmed
        guard !p.isEmpty, !settings.toolRootDirectories.contains(p) else { return }
        settings.toolRootDirectories.append(p)
    }

    func removeToolRootDirectory(_ path: String) {
        settings.toolRootDirectories.removeAll { $0 == path }
    }

    // MARK: MCP servers

    func addMCPServer(_ server: MCPServerConfig) {
        settings.mcpServers.append(server)
    }

    func removeMCPServer(id: String) {
        settings.mcpServers.removeAll { $0.id == id }
    }

    func updateMCPServer(id: String, _ mutate: (inout MCPServerConfig) -> Void) {
        guard let i = settings.mcpServers.firstIndex(where: { $0.id == id }) else { return }
        mutate(&settings.mcpServers[i])
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

    // MARK: Feedback sounds

    func addSoundCue(_ cue: SoundCue) {
        settings.feedbackSounds.cues.append(cue)
    }

    func updateSoundCue(id: String, _ mutate: (inout SoundCue) -> Void) {
        guard let i = settings.feedbackSounds.cues.firstIndex(where: { $0.id == id }) else { return }
        guard !settings.feedbackSounds.cues[i].isBuiltInSystemCue else { return }
        let before = settings.feedbackSounds.cues[i]
        mutate(&settings.feedbackSounds.cues[i])
        deleteUnreferencedImportedFiles(previouslyReferencedBy: before)
    }

    func removeSoundCue(id: String) {
        let removed = settings.feedbackSounds.cues.first { $0.id == id }
        guard removed?.isBuiltInSystemCue != true else { return }
        settings.feedbackSounds.cues.removeAll { $0.id == id }
        // Drop any event bindings that pointed at it.
        for (event, cueID) in settings.feedbackSounds.bindings where cueID == id {
            settings.feedbackSounds.bindings.removeValue(forKey: event)
        }
        if let removed {
            deleteUnreferencedImportedFiles(previouslyReferencedBy: removed)
        }
    }

    /// Bind an event to a cue (or to nothing, by passing `nil`).
    func bindFeedback(event: FeedbackEvent, to cueID: String?) {
        if let cueID {
            settings.feedbackSounds.bindings[event.rawValue] = cueID
        } else {
            settings.feedbackSounds.bindings.removeValue(forKey: event.rawValue)
        }
    }

    private func deleteUnreferencedImportedFiles(previouslyReferencedBy cue: SoundCue) {
        let active = Set(settings.feedbackSounds.cues.flatMap(\.importedFilenames))
        for filename in Set(cue.importedFilenames) where !active.contains(filename) {
            FeedbackSoundPlayer.deleteFile(filename: filename)
        }
    }
}
