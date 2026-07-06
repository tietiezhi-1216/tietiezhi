//  MCPManager.swift
//  External MCP client layer. Connects the user's configured MCP servers
//  (stdio subprocess or Streamable HTTP) via the official swift-sdk, lists
//  their tools, and registers each one into the shared ToolRegistry — so the
//  chat tool-loop treats MCP tools exactly like built-in skills.

import Foundation
import MCP
import System

@MainActor
final class MCPManager: ObservableObject {
    /// Per-server connection status, keyed by server id (for the settings UI).
    @Published private(set) var statuses: [String: String] = [:]
    /// Tool names each server contributed (registry names), keyed by server id.
    @Published private(set) var toolNames: [String: [String]] = [:]

    private let store: SettingsStore
    private let registry: ToolRegistry
    private var clients: [String: Client] = [:]
    private var processes: [String: Process] = [:]

    init(store: SettingsStore, registry: ToolRegistry) {
        self.store = store
        self.registry = registry
    }

    /// (Re)connect every enabled server: tear down old connections, then bring
    /// each one up and register its tools.
    func reconnectAll() async {
        await disconnectAll()
        for server in store.settings.mcpServers where server.enabled {
            await connect(server)
        }
    }

    func disconnectAll() async {
        for (id, names) in toolNames {
            names.forEach { registry.unregister(name: $0) }
            toolNames[id] = nil
        }
        for (_, client) in clients { await client.disconnect() }
        clients.removeAll()
        for (_, proc) in processes where proc.isRunning { proc.terminate() }
        processes.removeAll()
        statuses.removeAll()
    }

    private func connect(_ server: MCPServerConfig) async {
        statuses[server.id] = "连接中…"
        do {
            let transport: any Transport
            if server.kind == "http" {
                guard let url = URL(string: server.url.trimmed), url.scheme != nil else {
                    throw OrbitError("URL 无效")
                }
                transport = HTTPClientTransport(endpoint: url)
            } else {
                transport = try spawnStdio(server)
            }
            let client = Client(name: "Orbit", version: "1.0")
            _ = try await client.connect(transport: transport)
            clients[server.id] = client

            let (tools, _) = try await client.listTools()
            var registered: [String] = []
            for tool in tools {
                let proxy = MCPProxyTool(registryName: Self.registryName(server: server.name, tool: tool.name),
                                         toolName: tool.name,
                                         description: tool.description ?? tool.name,
                                         schema: Self.jsonObject(from: tool.inputSchema),
                                         client: client)
                registry.register(proxy)
                registered.append(proxy.spec.name)
            }
            toolNames[server.id] = registered
            statuses[server.id] = "已连接 · \(tools.count) 个工具"
        } catch {
            statuses[server.id] = "失败：\(error.localizedDescription)"
        }
    }

    /// Spawn a stdio MCP server through a login shell (so PATH-installed
    /// launchers like `npx` / `uvx` resolve) and bridge its pipes to the SDK.
    private func spawnStdio(_ server: MCPServerConfig) throws -> StdioTransport {
        let command = server.command.trimmed
        guard !command.isEmpty else { throw OrbitError("命令为空") }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", command]
        let toServer = Pipe()
        let fromServer = Pipe()
        proc.standardInput = toServer
        proc.standardOutput = fromServer
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        processes[server.id] = proc
        return StdioTransport(
            input: FileDescriptor(rawValue: fromServer.fileHandleForReading.fileDescriptor),
            output: FileDescriptor(rawValue: toServer.fileHandleForWriting.fileDescriptor))
    }

    /// OpenAI restricts tool names to `[A-Za-z0-9_-]{1,64}` — prefix with the
    /// server name so tools from different servers can't collide.
    static func registryName(server: String, tool: String) -> String {
        let sanitize: (String) -> String = { raw in
            String(raw.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? $0 : "_" })
        }
        let combined = "\(sanitize(server))_\(sanitize(tool))"
        return String(combined.prefix(64))
    }

    // MARK: - Value ⇄ JSON bridging (both are plain JSON trees)

    static func jsonObject(from value: Value) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(value),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return ["type": "object"] }
        return obj
    }

    static func values(from arguments: [String: Any]) -> [String: Value] {
        guard let data = try? JSONSerialization.data(withJSONObject: arguments),
              let decoded = try? JSONDecoder().decode([String: Value].self, from: data)
        else { return [:] }
        return decoded
    }
}

// MARK: - MCP tool → OrbitTool proxy

/// Wraps one remote MCP tool as a registry tool: encode args as `Value`s, call
/// through the client, and flatten the content blocks into a text result
/// (base64 image blocks are saved locally and surfaced as attachments).
struct MCPProxyTool: OrbitTool {
    let registryName: String
    let toolName: String
    let description: String
    let schema: [String: Any]
    let client: Client

    var displayName: String { toolName }
    var category: ToolCategory { .mcp }

    var spec: ToolSpec {
        ToolSpec(name: registryName, description: description, parameters: schema)
    }

    @MainActor
    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        let (content, isError) = try await client.callTool(
            name: toolName,
            arguments: MCPManager.values(from: arguments))
        var texts: [String] = []
        var attachments: [String] = []
        for block in content {
            switch block {
            case .text(let text, _, _):
                texts.append(text)
            case .image(let data, let mimeType, _, _):
                if let bytes = Data(base64Encoded: data) {
                    let ext = mimeType.contains("jpeg") ? "jpg" : (mimeType.contains("webp") ? "webp" : "png")
                    let url = GenerationStore.directory.appendingPathComponent("mcp-\(UUID().uuidString).\(ext)")
                    try? bytes.write(to: url, options: .atomic)
                    attachments.append(url.path)
                    texts.append("[已生成图片]")
                }
            case .resource(let resource, _, _):
                texts.append(String(describing: resource))
            default:
                continue
            }
        }
        let joined = texts.joined(separator: "\n")
        if isError == true {
            throw OrbitError(joined.isEmpty ? "MCP 工具执行失败" : joined)
        }
        return ToolOutput(content: joined.isEmpty ? "(无输出)" : joined, attachments: attachments)
    }
}
