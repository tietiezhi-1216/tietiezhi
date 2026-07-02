//  ChatRootView.swift
//  Orbit's primary surface: a chat (Agent) window — conversation sidebar + a
//  message transcript with a composer. Settings now switch into the same main
//  window as a workspace instead of opening as a sheet.

import SwiftUI
import AppKit

struct ChatRootView: View {
    /// Retained for menu-bar / external callers.
    let openSettings: () -> Void

    @EnvironmentObject private var app: AppController

    var body: some View {
        Group {
            switch app.workspace {
            case .chat:
                ChatWorkspaceView(openSettings: openSettings)
            case .creation:
                CreationWorkspaceView(openSettings: openSettings)
            case .settings:
                SettingsRootView()
            }
        }
        .frame(minWidth: 960, minHeight: 640)
        .ignoresSafeArea()
    }
}

private struct ChatWorkspaceView: View {
    let openSettings: () -> Void

    /// Persisted across launches; narrower default. Dragging the handle writes
    /// straight through to UserDefaults via @AppStorage.
    @AppStorage("orbit.chatSidebarWidth") private var sidebarWidth = 248.0

    var body: some View {
        ZStack(alignment: .topLeading) {
            HStack(spacing: 0) {
                ChatSidebarView(openSettings: openSettings)
                    .frame(width: CGFloat(sidebarWidth))

                ChatDetailView(openSettings: openSettings)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            SidebarResizeHandle(width: $sidebarWidth)
                .frame(width: 10)
                .offset(x: CGFloat(sidebarWidth) - 5)
        }
    }
}

private struct SidebarResizeHandle: View {
    @Binding var width: Double
    @State private var startWidth: Double?
    @State private var cursorPushed = false

    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .contentShape(Rectangle())
            .overlay {
                Rectangle()
                    .fill(Color(nsColor: .separatorColor).opacity(0.28))
                    .frame(width: 0.5)
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        if startWidth == nil { startWidth = width }
                        let next = (startWidth ?? width) + value.translation.width
                        width = min(max(next, 240), 380)
                    }
                    .onEnded { _ in
                        startWidth = nil
                    }
            )
            .onHover { hovering in
                if hovering, !cursorPushed {
                    NSCursor.resizeLeftRight.push()
                    cursorPushed = true
                } else if !hovering, cursorPushed {
                    NSCursor.pop()
                    cursorPushed = false
                }
            }
            .onDisappear {
                if cursorPushed {
                    NSCursor.pop()
                    cursorPushed = false
                }
            }
            .help("拖动调整侧边栏宽度")
    }
}
