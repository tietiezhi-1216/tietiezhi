//  OnboardingView.swift
//  First-run permission gate. Orbit's core — global voice dictation — can't work
//  until macOS grants three SEPARATE permissions: Microphone (record), Input
//  Monitoring (hear the global hotkey) and Accessibility (paste into the focused
//  app). Rather than failing silently in other apps, we surface this on launch
//  with live status and one-tap grants, and only hand off to the main window once
//  everything is granted.

import SwiftUI

struct OnboardingView: View {
    @ObservedObject var controller: AppController
    /// Called when the user proceeds (only enabled once everything is granted).
    var onContinue: () -> Void
    /// Relaunch Orbit — needed because macOS only applies a freshly-granted
    /// "Input Monitoring" toggle to the process after it restarts.
    var onRelaunch: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            VStack(spacing: 10) {
                permissionRow(
                    icon: "mic.fill",
                    title: "麦克风",
                    detail: "录制你的语音",
                    state: controller.micPermission,
                    grant: { controller.requestMicrophone() },
                    openSettings: { Permissions.openMicrophoneSettings() }
                )
                permissionRow(
                    icon: "keyboard",
                    title: "输入监控（推荐）",
                    detail: "监听全局热键；开启后需重启 Orbit 生效",
                    state: controller.inputMonitoringPermission,
                    grant: { controller.requestInputMonitoring() },
                    openSettings: { Permissions.openInputMonitoringSettings() }
                )
                permissionRow(
                    icon: "cursorarrow.click.2",
                    title: "辅助功能",
                    detail: "把识别结果粘贴进当前 App",
                    state: controller.axPermission,
                    grant: { controller.requestAccessibility() },
                    openSettings: { Permissions.openAccessibilitySettings() }
                )
            }
            .padding(.horizontal, 22)
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { controller.refreshStatus() }
    }

    // MARK: Header / footer

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 46))
                .foregroundStyle(.tint)
                .symbolRenderingMode(.hierarchical)
            Text("欢迎使用 Orbit")
                .font(.title2.weight(.bold))
            Text("开启全局语音听写前，先授予以下权限")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 30)
        .padding(.bottom, 20)
        .padding(.horizontal, 22)
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Button(action: onContinue) {
                Text(controller.requiredPermissionsGranted ? "进入 Orbit" : "请授予麦克风与辅助功能")
                    .frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)
            .disabled(!controller.requiredPermissionsGranted)

            Button("已在系统设置里授权？重启 Orbit 使其生效", action: onRelaunch)
                .buttonStyle(.link)
                .font(.caption)

            Text("「输入监控」在系统设置里打开后，需重启 Orbit 才会生效——这是 macOS 对事件监听的限制。其余权限授权后会自动进入。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 22)
        .padding(.top, 20)
        .padding(.bottom, 22)
    }

    // MARK: Row

    @ViewBuilder
    private func permissionRow(
        icon: String,
        title: String,
        detail: String,
        state: PermissionState,
        grant: @escaping () -> Void,
        openSettings: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(state == .granted ? Color.green : Color.accentColor)
                .frame(width: 34, height: 34)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color.primary.opacity(0.06))
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            statusControl(state: state, grant: grant, openSettings: openSettings)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(Color.primary.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.06))
                )
        )
    }

    @ViewBuilder
    private func statusControl(
        state: PermissionState,
        grant: @escaping () -> Void,
        openSettings: @escaping () -> Void
    ) -> some View {
        switch state {
        case .granted:
            Label("已授权", systemImage: "checkmark.circle.fill")
                .labelStyle(.titleAndIcon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)
        case .denied:
            Button("打开设置", action: openSettings)
                .controlSize(.small)
        case .notDetermined:
            Button("授权", action: grant)
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
        }
    }
}
