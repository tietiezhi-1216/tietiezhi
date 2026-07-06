//  ToolRegistry.swift
//  In-process "Skills": tools the chat model can invoke via function calling.
//  A tool is a name + JSON-Schema parameters + a native async handler. Built-in
//  skills (generate_image / generate_video) and external MCP tools (Phase D)
//  register into the same registry, so the chat tool-loop treats them uniformly.

import Foundation

/// What the model sees: the function declaration. `parameters` is a JSON Schema
/// object; each wire encodes it differently (OpenAI `parameters`, Anthropic
/// `input_schema`) but the schema itself is shared.
struct ToolSpec {
    let name: String
    let description: String
    let parameters: [String: Any]
}

/// A tool's outcome: the string fed back to the model, plus any local asset
/// paths the UI should render inline (e.g. a generated image).
struct ToolOutput {
    let content: String
    var attachments: [String] = []
}

/// UI grouping for a tool (drives the agent editor / tools page sections).
enum ToolCategory: String, Codable, CaseIterable, Hashable {
    case skill      // built-in generative skills (image / video)
    case file       // read / list / find / search / write / edit
    case command    // run a shell command
    case mcp        // provided by an external MCP server
    case other

    var displayName: String {
        switch self {
        case .skill:   return "内置技能"
        case .file:    return "文件"
        case .command: return "命令"
        case .mcp:     return "MCP 工具"
        case .other:   return "其它"
        }
    }

    var symbol: String {
        switch self {
        case .skill:   return "wand.and.stars"
        case .file:    return "folder"
        case .command: return "terminal"
        case .mcp:     return "puzzlepiece.extension"
        case .other:   return "wrench.and.screwdriver"
        }
    }
}

protocol OrbitTool {
    var spec: ToolSpec { get }
    // Declared as requirements (not extension-only) so overrides dynamic-dispatch
    // through the `OrbitTool` existential — otherwise the UI would always see the
    // extension defaults (everything `.other`, labelled by raw name).
    var displayName: String { get }
    var category: ToolCategory { get }
    var isDangerous: Bool { get }
    @MainActor func run(_ arguments: [String: Any]) async throws -> ToolOutput
}

/// UI-facing metadata with sensible defaults so most tools don't restate them.
extension OrbitTool {
    /// Friendly label (defaults to the raw tool name).
    var displayName: String { spec.name }
    var category: ToolCategory { .other }
    /// Mutating / executing tools that warrant a confirmation and a warning badge.
    var isDangerous: Bool { false }
}

/// Top-level bucket for the agent editor / tools page. 工具 = built-in local
/// file & command tools; 技能 = generative skills (image / video); MCP = tools
/// from external servers. Derived from a tool's finer `ToolCategory`.
enum CapabilityKind: String, CaseIterable, Identifiable, Hashable {
    // Order matters — drives the agent-editor tab order (工具 与 MCP 相邻，技能单列).
    case tools, mcp, skills

    var id: String { rawValue }

    var title: String {
        switch self {
        case .tools:  return "工具"
        case .skills: return "技能"
        case .mcp:    return "MCP"
        }
    }

    var symbol: String {
        switch self {
        case .tools:  return "hammer"
        case .skills: return "wand.and.stars"
        case .mcp:    return "puzzlepiece.extension"
        }
    }

    // Built-in generative tools (image/video) are function tools too, so they
    // live in the 工具 bucket alongside file/command/MCP. The 技能 tab is fed by
    // disk skills (SkillStore), not the tool registry.
    static func of(_ category: ToolCategory) -> CapabilityKind {
        switch category {
        case .file, .command, .skill, .other: return .tools
        case .mcp:                            return .mcp
        }
    }
}

@MainActor
final class ToolRegistry: ObservableObject {
    /// Published so the settings UI (agent editor / tools page) reflects tools
    /// appearing or disappearing as MCP servers connect.
    @Published private(set) var tools: [String: OrbitTool] = [:]

    func register(_ tool: OrbitTool) { tools[tool.spec.name] = tool }
    func unregister(name: String) { tools.removeValue(forKey: name) }
    var specs: [ToolSpec] { tools.values.map(\.spec).sorted { $0.name < $1.name } }
    /// All registered tools, sorted by category then name — for the UI.
    var all: [OrbitTool] {
        tools.values.sorted {
            $0.category.rawValue == $1.category.rawValue
                ? $0.spec.name < $1.spec.name
                : $0.category.rawValue < $1.category.rawValue
        }
    }
    var isEmpty: Bool { tools.isEmpty }
    func tool(named name: String) -> OrbitTool? { tools[name] }
    /// Registry names that are currently available (for pruning agent selections).
    var names: Set<String> { Set(tools.keys) }
}

// MARK: - Built-in skill: generate_image

/// Lets the chat model produce an image with the user's configured image model.
/// The handler runs the same pipeline as the 创作 panel (archive + usage), and
/// returns a compact JSON reference so the model can talk about the result.
struct GenerateImageTool: OrbitTool {
    let settings: SettingsStore
    let generation: GenerationStore

    var displayName: String { "生成图片" }
    var category: ToolCategory { .skill }

    var spec: ToolSpec {
        ToolSpec(
            name: "generate_image",
            description: "根据文字提示生成一张图片。当用户要求画图、生成图片、设计图像时调用。生成结果会直接展示给用户。",
            parameters: [
                "type": "object",
                "properties": [
                    "prompt": ["type": "string", "description": "图片内容的详细描述（英文效果通常更好）"],
                    "size": ["type": "string", "description": "尺寸，如 1024x1024、1792x1024", "enum": ["1024x1024", "1792x1024", "1024x1792"]],
                ] as [String: Any],
                "required": ["prompt"],
            ])
    }

    @MainActor
    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let prompt = arguments["prompt"] as? String, !prompt.isEmpty else {
            throw OrbitError("generate_image 缺少 prompt 参数。")
        }
        guard let model = settings.settings.imageModel ?? settings.settings.imageModels.first else {
            throw OrbitError("尚未配置图像模型：请在「渠道商」添加支持图像的渠道并加载模型。")
        }
        var params: [String: String] = [:]
        if let size = arguments["size"] as? String { params["size"] = size }
        let items = try await generation.generateImageNow(model: model, prompt: prompt, params: params)
        let paths = items.map { $0.fileURL.path }
        let json = "{\"status\":\"ok\",\"count\":\(items.count),\"note\":\"图片已生成并展示给用户\"}"
        return ToolOutput(content: json, attachments: paths)
    }
}

// MARK: - Built-in skill: generate_video

/// Lets the chat model produce a short video with the user's configured video
/// model. Generation is async upstream (tens of seconds to minutes); the tool
/// awaits completion and returns a file reference.
struct GenerateVideoTool: OrbitTool {
    let settings: SettingsStore
    let generation: GenerationStore

    var displayName: String { "生成视频" }
    var category: ToolCategory { .skill }

    var spec: ToolSpec {
        ToolSpec(
            name: "generate_video",
            description: "根据文字提示生成一段短视频。当用户要求生成视频、动画片段时调用。生成耗时较长（几十秒到几分钟），结果会直接展示给用户。",
            parameters: [
                "type": "object",
                "properties": [
                    "prompt": ["type": "string", "description": "视频内容的详细描述"],
                    "size": ["type": "string", "description": "分辨率，如 1280x720、720x1280"],
                ] as [String: Any],
                "required": ["prompt"],
            ])
    }

    @MainActor
    func run(_ arguments: [String: Any]) async throws -> ToolOutput {
        guard let prompt = arguments["prompt"] as? String, !prompt.isEmpty else {
            throw OrbitError("generate_video 缺少 prompt 参数。")
        }
        guard let model = settings.settings.videoModel ?? settings.settings.videoModels.first else {
            throw OrbitError("尚未配置视频模型：请在「渠道商」添加支持视频的渠道并加载模型。")
        }
        var params: [String: String] = [:]
        if let size = arguments["size"] as? String { params["size"] = size }
        let item = try await generation.generateVideoNow(model: model, prompt: prompt, params: params)
        return ToolOutput(content: "{\"status\":\"ok\",\"note\":\"视频已生成并展示给用户\"}",
                          attachments: [item.fileURL.path])
    }
}
