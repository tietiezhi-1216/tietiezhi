//  SettingsSidebarView.swift
//  The settings window's translucent left nav: real vibrancy behind, a brand
//  mark below the traffic lights, and accent-highlighted section rows.

import SwiftUI

struct SettingsSidebarView: View {
    @Binding var selection: SettingsSection

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            // Brand — pushed down so it clears the window traffic lights.
            HStack(spacing: 8) {
                Text("🛰️").font(.system(size: 16))
                Text("Orbit").font(.system(size: 15, weight: .semibold))
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 14)

            ForEach(SettingsSection.allCases) { section in
                SidebarRow(section: section,
                           isSelected: selection == section) {
                    selection = section
                }
            }

            Spacer(minLength: 0)

            VStack(alignment: .leading, spacing: 2) {
                Text("开放 · 多模态 · 去中心化")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Text("让每个模型成为一颗卫星")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 14)
        }
        .frame(width: 212, alignment: .leading)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(VisualEffectView(material: .sidebar))
    }
}

private struct SidebarRow: View {
    let section: SettingsSection
    let isSelected: Bool
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: section.symbol)
                    .font(.system(size: 13))
                    .frame(width: 18)
                Text(section.title)
                    .font(.system(size: 13))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(background)
            )
            .foregroundStyle(isSelected ? Color.white : Color.primary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .onHover { hovering = $0 }
    }

    private var background: Color {
        if isSelected { return .accentColor }
        if hovering { return .primary.opacity(0.08) }
        return .clear
    }
}
