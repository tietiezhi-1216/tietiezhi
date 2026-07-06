//  SettingsSection.swift
//  Stable identifiers for Orbit's in-window settings workspace, grouped into a
//  two-level sidebar: top-level groups (模型服务 / 听写 / 系统) each containing their
//  sections. The 听写 feature is split into its own group with sub-pages
//  (基础 / 模板 / 词汇 / 历史 / 统计) so each concern gets a focused screen.

import Foundation

/// A top-level sidebar group (parent menu).
enum SettingsGroup: Int, CaseIterable, Identifiable {
    case access          // 服务商 + 模型 — where models come from
    case capabilities    // 智能体 + 工具 + MCP — what the chat can do
    case dictation       // 听写功能的各个子页
    case capture         // 截图（区域截图 / 贴图）
    case personalization // 个性化（提示音等）
    case system          // 权限 & 关于

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .access:          return "模型服务"
        case .capabilities:    return "功能"
        case .dictation:       return "听写"
        case .capture:         return "截图"
        case .personalization: return "个性化"
        case .system:          return "系统"
        }
    }
}

enum SettingsSection: String, CaseIterable, Identifiable {
    case providers
    case usage
    case agents
    case tools
    case mcp
    case skills
    case dictationBasic
    case dictationModes
    case dictationVocab
    case dictationHistory
    case dictationStats
    case captureBasic
    case captureHistory
    case shortcuts
    case feedbackSounds
    case about

    var id: Self { self }

    /// The parent group this section lives under.
    var group: SettingsGroup {
        switch self {
        case .providers, .usage:
            return .access
        case .agents, .tools, .mcp, .skills:
            return .capabilities
        case .dictationBasic, .dictationModes, .dictationVocab, .dictationHistory, .dictationStats:
            return .dictation
        case .captureBasic, .captureHistory:
            return .capture
        case .shortcuts, .feedbackSounds:
            return .personalization
        case .about:
            return .system
        }
    }

    var title: String {
        switch self {
        case .providers:        return "渠道商"
        case .usage:            return "用量"
        case .agents:           return "智能体"
        case .tools:            return "工具"
        case .mcp:              return "MCP"
        case .skills:           return "技能"
        case .dictationBasic:   return "基础"
        case .dictationModes:   return "模板"
        case .dictationVocab:   return "词汇"
        case .dictationHistory: return "历史"
        case .dictationStats:   return "统计"
        case .captureBasic:     return "基础"
        case .captureHistory:   return "历史"
        case .shortcuts:        return "快捷键"
        case .feedbackSounds:   return "提示音"
        case .about:            return "权限 & 关于"
        }
    }

    var symbol: String {
        switch self {
        case .providers:        return "server.rack"
        case .usage:            return "creditcard"
        case .agents:           return "person.2"
        case .tools:            return "hammer"
        case .mcp:              return "puzzlepiece.extension"
        case .skills:           return "wand.and.stars"
        case .dictationBasic:   return "mic"
        case .dictationModes:   return "slider.horizontal.3"
        case .dictationVocab:   return "character.book.closed"
        case .dictationHistory: return "clock.arrow.circlepath"
        case .dictationStats:   return "chart.bar"
        case .captureBasic:     return "camera.viewfinder"
        case .captureHistory:   return "photo.on.rectangle.angled"
        case .shortcuts:        return "keyboard"
        case .feedbackSounds:   return "speaker.wave.2.fill"
        case .about:            return "lock.shield"
        }
    }

    /// Sections belonging to a group, in declaration order.
    static func sections(in group: SettingsGroup) -> [SettingsSection] {
        allCases.filter { $0.group == group }
    }
}
