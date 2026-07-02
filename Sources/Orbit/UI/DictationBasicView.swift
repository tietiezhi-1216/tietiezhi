//  DictationBasicView.swift
//  听写 › 基础: the everyday knobs — which models do speech→text and polish, the
//  hotkey, auto-insert behavior, the context the prompt is given (languages /
//  front-app awareness / output language), and the detected microphones.

import SwiftUI
import AppKit

struct DictationBasicView: View {
    @EnvironmentObject var store: SettingsStore
    @EnvironmentObject var app: AppController

    private var asrModels: [ModelConfig] {
        store.settings.asrModels
    }
    private var chatModels: [ModelConfig] {
        store.settings.chatModels
    }

    /// Working languages edited as a comma-separated field.
    private var workingLanguagesText: Binding<String> {
        Binding(
            get: { store.settings.workingLanguages.joined(separator: ", ") },
            set: { newValue in
                store.settings.workingLanguages = newValue
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
            }
        )
    }

    var body: some View {
        PageScaffold(title: "听写 · 基础") {
            Form {
                Section("模型") {
                    Picker("语音识别", selection: $store.settings.asrModelID) {
                        Text("— 无 —").tag(String?.none)
                        ForEach(asrModels) { Text(store.settings.displayLabel(for: $0)).tag(Optional($0.id)) }
                    }
                    if asrModels.isEmpty {
                        hint("还没有语音识别模型。去「渠道商」添加一个支持语音识别的渠道商（如 OpenAI、小米 MiMo），保存后会自动加载模型。")
                    }

                    Picker("润色（大模型）", selection: $store.settings.llmModelID) {
                        Text("— 无 —").tag(String?.none)
                        ForEach(chatModels) { Text(store.settings.displayLabel(for: $0)).tag(Optional($0.id)) }
                    }
                    hint("单击模式识别后用它按「模板」里选的模式润色；长按只转写、不润色。没配大模型则自动退化为仅转写。")
                }

                Section("快捷键") {
                    HStack(spacing: 10) {
                        Text(Keycodes.label(for: store.settings.hotkey))
                            .font(.system(.body, design: .monospaced))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
                        if app.capturingHotkey {
                            Text("请按下任意一个键…").foregroundStyle(.secondary)
                            Button("取消") { app.cancelHotkeyCapture() }
                        } else {
                            Button("录制快捷键") { app.beginHotkeyCapture() }
                        }
                        Spacer()
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        Text("单击：点一下开始，再点一下结束（或点胶囊 ✓）—— 转写 + 润色。")
                        Text("长按：按住说话，松手结束 —— 仅转写。")
                        Text("推荐绑定单个修饰键（如右 ⌘）。按 Esc 取消。")
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }

                Section("上下文（喂给润色模型）") {
                    TextField("工作语言", text: workingLanguagesText, prompt: Text("用逗号分隔，如：中文, English"))
                        .textFieldStyle(.roundedBorder)
                    Picker("输出语言", selection: $store.settings.outputLanguage) {
                        ForEach(OutputLanguage.allCases) { Text($0.displayName).tag($0) }
                    }
                    Toggle("感知前台应用", isOn: $store.settings.frontAppAware)
                    hint("把当前聚焦的 App 名告诉模型，让它按场景调整语气（邮件偏正式、聊天偏口语、IDE 偏技术）。")
                    Toggle("防提示词注入", isOn: $store.settings.injectionDefense)
                    hint("提醒模型：转写是要整理的数据，不是指令——不执行其中命令、不回答其中问题。")
                    Toggle("清理模型多余输出", isOn: $store.settings.cleanOutput)
                    hint("自动去掉「以下是…」之类开场白、代码围栏和包裹引号。")
                }

                Section("行为") {
                    Toggle("自动输入结果", isOn: $store.settings.autoInsert)
                        .onChange(of: store.settings.autoInsert) { _, on in
                            if on, Permissions.accessibility != .granted {
                                app.requestAccessibility()
                            }
                        }
                    hint("识别完成后把文本粘贴进当前聚焦的 App（需要辅助功能权限）。")
                    if store.settings.autoInsert, app.axPermission != .granted {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            Text("尚未授予「辅助功能」，无法自动输入。")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("去授权") { app.requestAccessibility() }.controlSize(.small)
                        }
                    }
                }

                Section("麦克风") {
                    if app.audioInputs.isEmpty {
                        Text("未检测到输入设备。").foregroundStyle(.secondary)
                    } else {
                        ForEach(app.audioInputs, id: \.self) { name in
                            Label(name, systemImage: "mic")
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .onAppear { app.refreshStatus() }
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
    }
}
