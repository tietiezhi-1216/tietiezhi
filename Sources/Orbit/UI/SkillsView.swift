//  SkillsView.swift
//  功能 › 技能: skills are folders under ~/.orbit/skills (each with a SKILL.md) —
//  discovered from disk, not added through a form. This page shows where they
//  live, lets you open / rescan the folder, and lists what was found. Which
//  skills an agent uses is chosen per-agent in the 智能体 editor.

import SwiftUI
import AppKit

struct SkillsView: View {
    @EnvironmentObject var skills: SkillStore

    private var directory: URL { SkillStore.directory }

    var body: some View {
        PageScaffold(title: "功能 · 技能") {
            HStack(spacing: 8) {
                Button { skills.reload() } label: {
                    Label("重新扫描", systemImage: "arrow.clockwise")
                }
                Button { openFolder() } label: {
                    Label("打开技能文件夹", systemImage: "folder")
                }
                .buttonStyle(.borderedProminent)
            }
        } content: {
            Form {
                Section {
                    Text("技能是一段可复用的指令包。把每个技能放成一个文件夹，内含 `SKILL.md`（开头用 `---` 写 name / description，正文写指令），放到下面的目录里，点「重新扫描」即可被读取。启用哪些技能，在「智能体」里为每个智能体勾选——启用后其指令会并入该智能体的系统提示词。")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        Image(systemName: "folder").foregroundStyle(.secondary)
                        Text(directory.path).font(.callout.monospaced())
                            .textSelection(.enabled).lineLimit(1).truncationMode(.middle)
                    }
                }

                Section("已发现的技能（\(skills.skills.count)）") {
                    if skills.skills.isEmpty {
                        Text("还没有技能。点「打开技能文件夹」，在里面新建一个文件夹（如 `code-review`），放入 `SKILL.md`，再点「重新扫描」。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(skills.skills) { skill in
                            skillRow(skill)
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
        .onAppear { skills.reload() }
    }

    private func skillRow(_ skill: Skill) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "wand.and.stars").foregroundStyle(.secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(skill.displayName).font(.callout.weight(.medium))
                    Text(skill.id).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                }
                Text(skill.description.isEmpty ? "（无描述）" : skill.description)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button { NSWorkspace.shared.open(skill.directory) } label: {
                Image(systemName: "arrow.up.forward.app")
            }
            .buttonStyle(.borderless).help("在访达中打开")
        }
        .padding(.vertical, 2)
    }

    private func openFolder() {
        skills.ensureDirectory()
        NSWorkspace.shared.open(directory)
    }
}
