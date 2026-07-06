//  Agent.swift
//  A chat "agent" (like Trae's agents): a named persona = a system prompt + a
//  chosen set of tools/skills. The user creates several and switches the active
//  one from the chat composer, so a "写代码" agent and a "翻译" agent can share
//  the same underlying model but bring different instructions and capabilities.
//
//  Tools are referenced by their registry name (built-in skills, the OpenCode
//  file/command tools, and MCP tools all live in one `ToolRegistry`), so an
//  agent's `enabledTools` is just a name set intersected with whatever is
//  actually registered at send time.
//
//  Persisted inside `Settings`; decoding stays tolerant of missing fields.

import Foundation

struct Agent: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    /// SF Symbol shown in the switcher / list.
    var icon: String
    /// The system prompt sent ahead of the conversation. Empty = no system turn.
    var systemPrompt: String
    /// Registry names of the tools (built-in + MCP) this agent may call.
    var enabledTools: Set<String>
    /// Ids of the disk skills (see Skill / SkillStore) this agent uses; their
    /// instructions are folded into the system prompt.
    var enabledSkills: Set<String>

    init(id: String = UUID().uuidString,
         name: String = "",
         icon: String = "sparkles",
         systemPrompt: String = "",
         enabledTools: Set<String> = [],
         enabledSkills: Set<String> = []) {
        self.id = id
        self.name = name
        self.icon = icon
        self.systemPrompt = systemPrompt
        self.enabledTools = enabledTools
        self.enabledSkills = enabledSkills
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "智能体"
        icon = try c.decodeIfPresent(String.self, forKey: .icon) ?? "sparkles"
        systemPrompt = try c.decodeIfPresent(String.self, forKey: .systemPrompt) ?? ""
        enabledTools = try c.decodeIfPresent(Set<String>.self, forKey: .enabledTools) ?? []
        enabledSkills = try c.decodeIfPresent(Set<String>.self, forKey: .enabledSkills) ?? []
    }

    var displayName: String { name.trimmed.isEmpty ? "未命名智能体" : name }

    /// The out-of-the-box agents seeded for a fresh install: a plain assistant
    /// (no tools) and a code agent (all file/command tools). Tool names match the
    /// registry names defined in AgentTools / ToolRegistry.
    static var seeded: [Agent] {
        [
            Agent(id: "agent-default", name: "通用助手", icon: "sparkles",
                  systemPrompt: "你是 Orbit 的 AI 助手，回答简洁、准确、友好。",
                  enabledTools: ["generate_image", "generate_video"]),
            Agent(id: "agent-coder", name: "编码助手", icon: "chevron.left.forwardslash.chevron.right",
                  systemPrompt: """
                  你是一个严谨的编程助手。可以读取、搜索、编辑本地文件并执行命令来完成任务。\
                  改动前先说明计划；只在必要时修改文件；破坏性操作会向用户请求确认。
                  """,
                  enabledTools: [
                    "read_file", "list_dir", "find_files", "search_files",
                    "write_file", "edit_file", "run_command",
                  ]),
        ]
    }
}
