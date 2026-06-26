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

                Section("软件更新") {
                    LabeledContent("当前版本") {
                        Text("\(app.currentVersion) (\(app.currentBuild)) · \(app.currentArchitecture)")
                            .foregroundStyle(.secondary)
                    }
                    LabeledContent("更新来源") {
                        Text("GitHub Releases")
                            .foregroundStyle(.secondary)
                    }

                    updateStatus

                    HStack {
                        Button(app.updateStatus.isBusy ? "正在处理…" : "检查更新") {
                            app.checkForUpdates()
                        }
                        .disabled(app.updateStatus.isBusy)

                        Button("打开发布页") {
                            app.openReleasePage()
                        }
                    }
                }

                Section("关于") {
                    LabeledContent("Orbit", value: "\(app.currentVersion) · 原生 macOS 版")
                    Text("系统级语音听写。第一颗卫星已起飞。")
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

    @ViewBuilder
    private var updateStatus: some View {
        switch app.updateStatus {
        case .idle:
            Text("点击「检查更新」会从 GitHub Releases 获取最新版本，并下载对应架构的 DMG。")
                .font(.caption)
                .foregroundStyle(.secondary)

        case .checking:
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                Text("正在检查 GitHub Releases…")
                    .foregroundStyle(.secondary)
            }

        case .upToDate(let version):
            Label("已是最新版本 \(version)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)

        case .available(let update):
            VStack(alignment: .leading, spacing: 10) {
                Label("发现新版本 \(update.version)", systemImage: "arrow.down.circle.fill")
                    .foregroundStyle(.blue)
                Text("\(update.displayTitle) · \(fileSize(update.assetSize))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if update.isPrerelease {
                    Text("预览版更新，会下载并校验 GitHub Actions 产出的安装包。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !update.releaseNotes.trimmed.isEmpty {
                    DisclosureGroup("发布说明") {
                        ScrollView {
                            Text(update.releaseNotes)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 4)
                        }
                        .frame(maxHeight: 160)
                    }
                }
                HStack {
                    Button("下载并打开安装包") {
                        app.downloadAndOpenUpdate(update)
                    }
                    Button("查看发布页") {
                        app.openReleasePage(update.releaseURL)
                    }
                }
            }

        case .downloading(let update, let progress):
            VStack(alignment: .leading, spacing: 8) {
                ProgressView(value: progress) {
                    Text("正在下载 \(update.assetName)")
                } currentValueLabel: {
                    Text("\(Int((progress * 100).rounded()))%")
                }
                Text("下载完成后会校验 SHA256，校验通过再打开 DMG。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

        case .downloaded(let update, let fileURL):
            VStack(alignment: .leading, spacing: 8) {
                Label("已下载并通过校验：\(update.version)", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Text(fileURL.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Button("重新打开安装包") {
                    app.openDownloadedUpdate(fileURL)
                }
            }

        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                Label("更新失败", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private func fileSize(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
