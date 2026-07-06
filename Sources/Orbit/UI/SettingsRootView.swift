//  SettingsRootView.swift
//  In-window settings workspace: dedicated settings sidebar + detail pane.
//  Reads AppController and SettingsStore from the environment.

import SwiftUI

struct SettingsRootView: View {
    @EnvironmentObject private var app: AppController

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebarView()
            Divider()

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var content: some View {
        switch app.settingsSection {
        case .providers:        ProvidersView()
        case .agents:           AgentsView()
        case .tools:            ToolsView()
        case .mcp:              MCPServersView()
        case .skills:           SkillsView()
        case .usage:            UsageStatsView()
        case .dictationBasic:   DictationBasicView()
        case .dictationModes:   DictationModesView()
        case .dictationVocab:   DictationVocabView()
        case .dictationHistory: DictationHistoryView()
        case .dictationStats:   DictationStatsView()
        case .captureBasic:     CaptureBasicView()
        case .captureHistory:   CaptureHistoryView()
        case .shortcuts:        ShortcutsView()
        case .feedbackSounds:   FeedbackSoundsView()
        case .about:            PermissionsView()
        }
    }
}
