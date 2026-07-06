//  MCPServersView.swift
//  模型服务 › MCP: manage external MCP servers. Add a stdio command or an HTTP
//  endpoint, toggle it, and reconnect; each connected server's tools become
//  chat-callable skills alongside the built-in ones.

import SwiftUI

struct MCPServersView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var mcp: MCPManager

    @State private var showingAdd = false
    @State private var editing: MCPServerConfig?
    @State private var reconnecting = false

    var body: some View {
        PageScaffold(title: "功能 · MCP") {
            HStack(spacing: 8) {
                Button { reconnect() } label: {
                    Label(reconnecting ? "连接中…" : "重新连接", systemImage: "arrow.clockwise")
                }
                .disabled(reconnecting || store.settings.mcpServers.isEmpty)

                Button { showingAdd = true } label: {
                    Label("添加服务器", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            Form {
                Section {
                    if store.settings.mcpServers.isEmpty {
                        Text("MCP（Model Context Protocol）服务器为对话模型提供外部工具。添加后其工具与内置技能一样可被对话调用。支持本地命令（stdio，如 npx …）与远程 URL（HTTP）。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(store.settings.mcpServers) { server in
                            row(server)
                        }
                    }
                } footer: {
                    Text("修改配置后点「重新连接」生效。工具名会以「服务器名_工具名」注册，避免不同服务器重名。")
                }
            }
            .formStyle(.grouped)
        }
        .sheet(isPresented: $showingAdd) {
            MCPServerSheet { server in
                store.addMCPServer(server)
                reconnect()
            }
        }
        .sheet(item: $editing) { server in
            MCPServerSheet(editing: server) { updated in
                store.updateMCPServer(id: server.id) { $0 = updated }
                reconnect()
            }
        }
    }

    private func row(_ server: MCPServerConfig) -> some View {
        HStack(spacing: 10) {
            Toggle("", isOn: Binding(
                get: { server.enabled },
                set: { on in store.updateMCPServer(id: server.id) { $0.enabled = on }; reconnect() }
            )).labelsHidden().toggleStyle(.switch).controlSize(.mini)

            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(.callout)
                Text(server.kind == "http" ? server.url : server.command)
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            Text(mcp.statuses[server.id] ?? (server.enabled ? "未连接" : "已停用"))
                .font(.caption).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail).frame(maxWidth: 220, alignment: .trailing)

            Button { editing = server } label: { Image(systemName: "pencil") }
                .buttonStyle(.borderless)
            Button(role: .destructive) {
                store.removeMCPServer(id: server.id); reconnect()
            } label: { Image(systemName: "trash") }
                .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }

    private func reconnect() {
        reconnecting = true
        Task { @MainActor in
            await mcp.reconnectAll()
            reconnecting = false
        }
    }
}

// MARK: - Add / edit sheet

private struct MCPServerSheet: View {
    var editing: MCPServerConfig?
    var onSave: (MCPServerConfig) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft: MCPServerConfig

    init(editing: MCPServerConfig? = nil, onSave: @escaping (MCPServerConfig) -> Void) {
        self.editing = editing
        self.onSave = onSave
        _draft = State(initialValue: editing ?? MCPServerConfig())
    }

    private var canSave: Bool {
        !draft.name.trimmed.isEmpty
            && (draft.kind == "http" ? !draft.url.trimmed.isEmpty : !draft.command.trimmed.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(editing == nil ? "添加 MCP 服务器" : "编辑 MCP 服务器").font(.headline)
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 14)
            Divider()

            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Text("名称").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
                    TextField("如 filesystem", text: $draft.name).textFieldStyle(.roundedBorder)
                }
                HStack(spacing: 12) {
                    Text("类型").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
                    Picker("", selection: $draft.kind) {
                        Text("本地命令（stdio）").tag("stdio")
                        Text("远程 URL（HTTP）").tag("http")
                    }
                    .labelsHidden().pickerStyle(.segmented).frame(width: 280)
                }
                if draft.kind == "http" {
                    HStack(spacing: 12) {
                        Text("URL").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
                        TextField("https://…/mcp", text: $draft.url).textFieldStyle(.roundedBorder)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 12) {
                            Text("命令").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
                            TextField("npx -y @modelcontextprotocol/server-filesystem ~/Documents",
                                      text: $draft.command)
                                .textFieldStyle(.roundedBorder).font(.callout.monospaced())
                        }
                        Text("经登录 shell 启动（PATH 生效），可直接用 npx / uvx。")
                            .font(.caption2).foregroundStyle(.tertiary).padding(.leading, 72)
                    }
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 18)

            Spacer(minLength: 0)
            Divider()
            HStack {
                Spacer()
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("保存") {
                    var s = draft
                    s.name = s.name.trimmed
                    s.command = s.command.trimmed
                    s.url = s.url.trimmed
                    onSave(s)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction).disabled(!canSave)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
        }
        .frame(width: 520, height: 300)
    }
}
