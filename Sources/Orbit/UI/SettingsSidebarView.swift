//  SettingsSidebarView.swift
//  Codex-style in-window settings navigation.

import SwiftUI

struct SettingsSidebarView: View {
    @EnvironmentObject private var app: AppController
    @State private var searchText = ""

    /// Sections matching the current search (all when empty).
    private var filteredSections: [SettingsSection] {
        guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return SettingsSection.allCases
        }
        let needle = searchText.localizedLowercase
        return SettingsSection.allCases.filter { $0.title.localizedLowercase.contains(needle) }
    }

    private func sections(in group: SettingsGroup) -> [SettingsSection] {
        filteredSections.filter { $0.group == group }
    }

    /// Groups that still have at least one visible section.
    private var visibleGroups: [SettingsGroup] {
        SettingsGroup.allCases.filter { !sections(in: $0).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                app.openChatWorkspace()
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                    Text("返回应用")
                }
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .frame(height: 32)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .padding(.top, 54)
            .padding(.horizontal, 10)
            .padding(.bottom, 14)

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
                TextField("搜索设置…", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08))
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 18)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(visibleGroups) { group in
                        Text(group.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .textCase(nil)
                            .padding(.horizontal, 18)
                            .padding(.top, 14)
                            .padding(.bottom, 4)

                        ForEach(sections(in: group)) { section in
                            SettingsSidebarRow(section: section,
                                               isSelected: app.settingsSection == section) {
                                app.settingsSection = section
                            }
                        }
                    }
                }
                .padding(.bottom, 12)
            }

            Spacer(minLength: 0)
        }
        .frame(width: 216)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(VisualEffectView(material: .sidebar))
    }
}

private struct SettingsSidebarRow: View {
    let section: SettingsSection
    let isSelected: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            // Explicit HStack (not Label): the icon sits in a fixed 20×20 slot so
            // its position never depends on the title's font metrics, and the row
            // has a fixed height — together they stop the selection-driven reflow
            // that made every icon jitter when switching pages.
            HStack(spacing: 9) {
                Image(systemName: section.symbol)
                    .font(.system(size: 13))
                    .frame(width: 20, height: 20)
                Text(section.title)
                    .font(.system(size: 14, weight: isSelected ? .semibold : .regular))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .foregroundStyle(isSelected ? Color.primary : Color.secondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .onHover { hovering = $0 }
    }

    private var background: Color {
        if isSelected { return Color.primary.opacity(0.12) }
        if hovering { return Color.primary.opacity(0.07) }
        return .clear
    }
}
