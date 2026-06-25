//  PermissionsView.swift
//  First-run onboarding: microphone + accessibility status with one-tap grant /
//  open-settings, plus an About blurb.

import SwiftUI

struct PermissionsView: View {
    @EnvironmentObject var app: AppController

    var body: some View {
        PageScaffold(title: "权限 & 关于") {
            Form {
                Section("权限") {
                    permissionRow(
                        title: "麦克风",
                        hint: "录制语音所需",
                        state: app.micPermission,
                        grant: { app.requestMicrophone() },
                        openSettings: { Permissions.openMicrophoneSettings() }
                    )
                    permissionRow(
                        title: "输入监控",
                        hint: "监听全局热键，随处唤起听写",
                        state: app.inputMonitoringPermission,
                        grant: { app.requestInputMonitoring() },
                        openSettings: { Permissions.openInputMonitoringSettings() }
                    )
                    permissionRow(
                        title: "辅助功能",
                        hint: "把识别结果粘贴进当前 App",
                        state: app.axPermission,
                        grant: { app.requestAccessibility() },
                        openSettings: { Permissions.openAccessibilitySettings() }
                    )
                    Button("重新检测权限") { app.refreshStatus() }
                }

                Section("关于") {
                    LabeledContent("Orbit", value: "0.1.0 · 原生 macOS 版")
                    Text("系统级语音听写。第一颗卫星已起飞 🛰️")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .onAppear { app.refreshStatus() }
        }
    }

    @ViewBuilder
    private func permissionRow(
        title: String,
        hint: String,
        state: PermissionState,
        grant: @escaping () -> Void,
        openSettings: @escaping () -> Void
    ) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(hint).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            switch state {
            case .granted:
                Label("已授权", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .denied:
                Button("打开系统设置") { openSettings() }
            case .notDetermined:
                Button("授权") { grant() }
            }
        }
    }
}
