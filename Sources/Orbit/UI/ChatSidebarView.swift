//  ChatSidebarView.swift
//  Chat sidebar: brand, 新对话, conversation history, and a bottom-left 设置
//  control that pops a menu UPWARD (设置 / 关于 / 退出).

import SwiftUI
import AppKit

struct ChatSidebarView: View {
    @EnvironmentObject var chat: ChatStore
    let openSettings: () -> Void

    @State private var showMenu = false
    @State private var settingsHover = false

    var body: some View {
        VStack(spacing: 0) {
            // Brand — pushed below the traffic lights.
            HStack(spacing: 8) {
                Text("🛰️").font(.system(size: 16))
                Text("Orbit").font(.system(size: 15, weight: .semibold))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 34)
            .padding(.bottom, 12)

            // New conversation.
            Button {
                chat.newConversation()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.pencil")
                    Text("新对话")
                    Spacer(minLength: 0)
                }
                .font(.system(size: 13, weight: .medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.accentColor.opacity(0.16)))
                .foregroundStyle(Color.accentColor)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.bottom, 8)

            // History.
            List(selection: $chat.selectedID) {
                ForEach(chat.conversations) { convo in
                    Text(convo.title.isEmpty ? "新对话" : convo.title)
                        .lineLimit(1)
                        .tag(convo.id)
                        .contextMenu {
                            Button("删除", role: .destructive) {
                                chat.deleteConversation(id: convo.id)
                            }
                        }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)

            // Bottom-left settings control — a floating row (like 新对话), not a
            // full-width bar glued to the window edge.
            Button {
                showMenu.toggle()
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "gearshape").frame(width: 18)
                    Text("设置").font(.system(size: 13))
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(settingsHover ? Color.primary.opacity(0.08) : .clear))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { settingsHover = $0 }
            .padding(.horizontal, 10)
            .padding(.top, 4)
            .padding(.bottom, 10)
            .popover(isPresented: $showMenu, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    PopMenuButton(title: "设置", system: "gearshape") {
                        showMenu = false
                        openSettings()
                    }
                    PopMenuButton(title: "关于 Orbit", system: "info.circle") {
                        showMenu = false
                        NSApp.orderFrontStandardAboutPanel(nil)
                    }
                    Divider().padding(.vertical, 2)
                    PopMenuButton(title: "退出 Orbit", system: "power") {
                        NSApp.terminate(nil)
                    }
                }
                .padding(8)
                .frame(width: 200)
            }
        }
        .frame(width: 240)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(VisualEffectView(material: .sidebar))
    }
}

private struct PopMenuButton: View {
    let title: String
    let system: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: system).frame(width: 16)
                Text(title)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6)
                .fill(hovering ? Color.primary.opacity(0.08) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
