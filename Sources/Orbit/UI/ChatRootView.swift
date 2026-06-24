//  ChatRootView.swift
//  Orbit's primary surface: a chat (Agent) window — conversation sidebar + a
//  message transcript with a composer. Settings open as a sheet ON THIS window
//  (not a separate window), driven by AppController.settingsPresented.

import SwiftUI

struct ChatRootView: View {
    /// Retained for menu-bar / external callers; in-window opening uses the flag.
    let openSettings: () -> Void

    @EnvironmentObject private var app: AppController

    var body: some View {
        HStack(spacing: 0) {
            ChatSidebarView(openSettings: { app.settingsPresented = true })
            Divider()
            ChatDetailView(openSettings: { app.settingsPresented = true })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 900, minHeight: 600)
        .ignoresSafeArea()
        .sheet(isPresented: $app.settingsPresented) {
            SettingsSheet()
        }
    }
}

/// The settings UI as a contained modal sheet over the chat window.
private struct SettingsSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("设置").font(.headline)
                HStack {
                    Spacer()
                    Button("完成") { dismiss() }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 48)

            Divider()

            SettingsRootView()
        }
        .frame(width: 780, height: 560)
    }
}
