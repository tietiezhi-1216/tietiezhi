//  SettingsRootView.swift
//  The settings window shell: a custom translucent sidebar + a content pane,
//  under a transparent full-size titlebar (configured in AppDelegate). Reads the
//  AppController and SettingsStore from the environment.

import SwiftUI

enum SettingsSection: String, CaseIterable, Identifiable {
    case providers, models, dictation, templates, about

    var id: Self { self }

    var title: String {
        switch self {
        case .providers: return "服务商"
        case .models:    return "模型"
        case .dictation: return "听写"
        case .templates: return "模板"
        case .about:     return "权限 & 关于"
        }
    }

    var symbol: String {
        switch self {
        case .providers: return "server.rack"
        case .models:    return "cube.box"
        case .dictation: return "mic"
        case .templates: return "text.quote"
        case .about:     return "lock.shield"
        }
    }
}

struct SettingsRootView: View {
    @State private var selection: SettingsSection = .providers

    var body: some View {
        HStack(spacing: 0) {
            SettingsSidebarView(selection: $selection)
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var content: some View {
        switch selection {
        case .providers: ProvidersView()
        case .models:    ModelsView()
        case .dictation: DictationView()
        case .templates: TemplatesView()
        case .about:     PermissionsView()
        }
    }
}
