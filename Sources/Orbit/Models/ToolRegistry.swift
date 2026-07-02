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

protocol OrbitTool {
    var spec: ToolSpec { get }
    @MainActor func run(_ arguments: [String: Any]) async throws -> ToolOutput
}

@MainActor
final class ToolRegistry: ObservableObject {
    private(set) var tools: [String: OrbitTool] = [:]

    func register(_ tool: OrbitTool) { tools[tool.spec.name] = tool }
    func unregister(name: String) { tools.removeValue(forKey: name) }
    var specs: [ToolSpec] { tools.values.map(\.spec).sorted { $0.name < $1.name } }
    var isEmpty: Bool { tools.isEmpty }
    func tool(named name: String) -> OrbitTool? { tools[name] }
}

// MARK: - Built-in skill: generate_image

/// Lets the chat model produce an image with the user's configured image model.
/// The handler runs the same pipeline as the 创作 panel (archive + usage), and
/// returns a compact JSON reference so the model can talk about the result.
struct GenerateImageTool: OrbitTool {
    let settings: SettingsStore
    let generation: GenerationStore

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
