//  ToolsView.swift
//  功能 › 工具: the catalog of built-in local tools the chat can call (read /
//  search / edit files, run commands, generate media). MCP tools live on the MCP
//  page; which tools an agent may use is chosen per-agent in the 智能体 editor.
//  The file/command tools are confined to a directory whitelist for safety — a
//  small secondary section at the bottom manages it.

import SwiftUI
import AppKit

struct ToolsView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var registry: ToolRegistry

    /// Built-in tools only (MCP tools are shown on the MCP page).
    private var builtInTools: [OrbitTool] {
        registry.all.filter { CapabilityKind.of($0.category) == .tools }
    }

    var body: some View {
        PageScaffold(title: "功能 · 工具") {
            Form {
                Section {
                    Text("对话智能体可调用的内置工具（与 MCP 工具同属「可调用工具」；MCP 工具见 MCP 页）。具体启用哪些，在「智能体」里为每个智能体单独勾选。")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("内置工具（\(builtInTools.count)）") {
                    if builtInTools.isEmpty {
                        Text("暂无内置工具。").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(builtInTools, id: \.spec.name) { tool in
                            toolRow(tool)
                        }
                    }
                }

                Section {
                    if store.settings.toolRootDirectories.isEmpty {
                        Text("尚未添加目录。未添加时，文件与命令类工具会拒绝运行。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(store.settings.toolRootDirectories, id: \.self) { path in
                            HStack(spacing: 8) {
                                Image(systemName: "folder").foregroundStyle(.secondary)
                                Text(path).font(.callout.monospaced())
                                    .lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Button(role: .destructive) {
                                    store.removeToolRootDirectory(path)
                                } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                            }
                        }
                    }
                    Button { addDirectory() } label: {
                        Label("添加目录…", systemImage: "plus")
                    }
                } header: {
                    Text("工作目录（文件 / 命令工具的白名单）")
                } footer: {
                    Label("为安全起见，文件与命令类工具只能在上面的目录内操作；编辑文件、执行命令等破坏性操作每次执行前还会弹窗请求确认。",
                          systemImage: "exclamationmark.shield")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
        }
    }

    private func toolRow(_ tool: OrbitTool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tool.category.symbol)
                .foregroundStyle(.secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(tool.displayName).font(.callout.weight(.medium))
                    Text(tool.spec.name).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    if tool.isDangerous {
                        Text("高危").font(.caption2.weight(.semibold))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.orange.opacity(0.15), in: Capsule())
                    }
                }
                Text(tool.spec.description)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private func addDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "添加"
        if panel.runModal() == .OK {
            for url in panel.urls { store.addToolRootDirectory(url.path) }
        }
    }
}
