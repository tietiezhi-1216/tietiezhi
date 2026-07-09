import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/settings_store.dart';
import '../theme.dart';

// ---- shared bits ----

class SettingsScaffold extends StatelessWidget {
  const SettingsScaffold({super.key, required this.title, this.subtitle, required this.children});
  final String title;
  final String? subtitle;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 28),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(title,
                  style: const TextStyle(
                      fontSize: 20, fontWeight: FontWeight.w700, color: OrbitColors.text)),
              if (subtitle != null) ...[
                const SizedBox(height: 4),
                Text(subtitle!, style: const TextStyle(fontSize: 13, color: OrbitColors.textDim)),
              ],
              const SizedBox(height: 18),
              ...children,
            ],
          ),
        ),
      ),
    );
  }
}

Widget _card({required Widget child}) => Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: OrbitColors.panel,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: OrbitColors.border),
      ),
      child: child,
    );

Widget _sectionLabel(String t) => Padding(
      padding: const EdgeInsets.only(top: 14, bottom: 6),
      child: Text(t,
          style: const TextStyle(
              fontSize: 12, fontWeight: FontWeight.w600, color: OrbitColors.textDim)),
    );

Widget _field(String label,
    {required String initial, required ValueChanged<String> onChanged, String? hint, bool obscure = false, Key? key}) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text(label, style: const TextStyle(fontSize: 12, color: OrbitColors.textDim)),
        ),
        TextFormField(
          key: key,
          initialValue: initial,
          obscureText: obscure,
          onChanged: onChanged,
          style: const TextStyle(fontSize: 14),
          decoration: InputDecoration(hintText: hint, isDense: true),
        ),
      ],
    ),
  );
}

Widget _switchRow(String label, bool value, ValueChanged<bool> onChanged, {String? sub}) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 3),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(fontSize: 14, color: OrbitColors.text)),
              if (sub != null)
                Text(sub, style: const TextStyle(fontSize: 11.5, color: OrbitColors.textDim)),
            ],
          ),
        ),
        Switch(value: value, onChanged: onChanged, activeThumbColor: OrbitColors.accent),
      ],
    ),
  );
}

// ---- 渠道商（Providers + Models CRUD）----

class ProvidersSection extends StatefulWidget {
  const ProvidersSection({super.key, required this.store});
  final SettingsStore store;

  @override
  State<ProvidersSection> createState() => _ProvidersSectionState();
}

class _ProvidersSectionState extends State<ProvidersSection> {
  SettingsStore get store => widget.store;
  Settings get s => store.settings;

  void _save() {
    store.save();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return SettingsScaffold(
      title: '渠道商',
      subtitle: '配置厂商（Base URL / API Key）与其下的模型；聊天与听写共用这里选中的模型。',
      children: [
        _sectionLabel('当前聊天模型'),
        _card(
          child: DropdownButton<String>(
            value: s.activeChatModel?.id,
            isExpanded: true,
            underline: const SizedBox(),
            dropdownColor: OrbitColors.panel,
            hint: const Text('（无可用模型）'),
            items: [
              for (final m in s.models)
                DropdownMenuItem(value: m.id, child: Text(m.displayName.isEmpty ? m.modelId : m.displayName)),
            ],
            onChanged: (id) {
              s.activeChatModelId = id;
              _save();
            },
          ),
        ),
        const SizedBox(height: 8),
        for (final p in s.providers) _providerCard(p),
        const SizedBox(height: 4),
        OutlinedButton.icon(
          onPressed: () {
            store.addProvider();
            _save();
          },
          icon: const Icon(Icons.add, size: 18),
          label: const Text('新增厂商'),
        ),
      ],
    );
  }

  Widget _providerCard(ApiProvider p) {
    final models = s.models.where((m) => m.providerId == p.id).toList();
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.dns_outlined, size: 18, color: OrbitColors.accent),
              const SizedBox(width: 8),
              Expanded(
                child: Text(p.name.isEmpty ? '未命名厂商' : p.name,
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: OrbitColors.text)),
              ),
              IconButton(
                tooltip: '删除厂商',
                icon: const Icon(Icons.delete_outline, size: 18, color: OrbitColors.textDim),
                onPressed: () {
                  s.providers.remove(p);
                  s.models.removeWhere((m) => m.providerId == p.id);
                  _save();
                },
              ),
            ],
          ),
          const SizedBox(height: 6),
          _field('名称', key: ValueKey('${p.id}-name'), initial: p.name, onChanged: (v) { p.name = v; store.save(); }),
          _field('Base URL', key: ValueKey('${p.id}-url'), initial: p.baseUrl, hint: 'https://api.openai.com/v1', onChanged: (v) { p.baseUrl = v; store.save(); }),
          _field('API Key', key: ValueKey('${p.id}-key'), initial: p.apiKey, obscure: true, onChanged: (v) { p.apiKey = v; store.save(); }),
          Row(children: [
            const Text('鉴权', style: TextStyle(fontSize: 12, color: OrbitColors.textDim)),
            const SizedBox(width: 10),
            DropdownButton<AuthScheme>(
              value: p.auth,
              dropdownColor: OrbitColors.panel,
              underline: const SizedBox(),
              items: [for (final a in AuthScheme.values) DropdownMenuItem(value: a, child: Text(a.displayName))],
              onChanged: (a) { p.auth = a ?? p.auth; _save(); },
            ),
          ]),
          const Divider(color: OrbitColors.border, height: 20),
          Text('模型（${models.length}）', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: OrbitColors.textDim)),
          const SizedBox(height: 4),
          for (final m in models) _modelRow(m),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () { store.addModel(p.id); _save(); },
              icon: const Icon(Icons.add, size: 16),
              label: const Text('加模型'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _modelRow(ModelConfig m) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(color: OrbitColors.panelAlt, borderRadius: BorderRadius.circular(9)),
      child: Column(
        children: [
          Row(children: [
            Expanded(child: _field('显示名', key: ValueKey('${m.id}-dn'), initial: m.displayName, onChanged: (v) { m.displayName = v; store.save(); })),
            const SizedBox(width: 8),
            Expanded(child: _field('模型 ID', key: ValueKey('${m.id}-mid'), initial: m.modelId, hint: 'gpt-4o-mini', onChanged: (v) { m.modelId = v; store.save(); })),
          ]),
          Row(children: [
            const Text('协议', style: TextStyle(fontSize: 12, color: OrbitColors.textDim)),
            const SizedBox(width: 10),
            DropdownButton<Wire>(
              value: m.wire,
              dropdownColor: OrbitColors.panel,
              underline: const SizedBox(),
              items: [for (final w in Wire.values) DropdownMenuItem(value: w, child: Text(w.displayName))],
              onChanged: (w) { m.wire = w ?? m.wire; _save(); },
            ),
            const Spacer(),
            IconButton(
              tooltip: '删除模型',
              icon: const Icon(Icons.close, size: 16, color: OrbitColors.textDim),
              onPressed: () { s.models.remove(m); _save(); },
            ),
          ]),
        ],
      ),
    );
  }
}

// ---- 听写 · 基础 ----

class DictationBasicSection extends StatefulWidget {
  const DictationBasicSection({super.key, required this.store});
  final SettingsStore store;
  @override
  State<DictationBasicSection> createState() => _DictationBasicSectionState();
}

class _DictationBasicSectionState extends State<DictationBasicSection> {
  SettingsStore get store => widget.store;
  DictationSettings get d => store.settings.dictation;
  void _save() { store.save(); setState(() {}); }

  @override
  Widget build(BuildContext context) {
    final s = store.settings;
    return SettingsScaffold(
      title: '听写 · 基础',
      subtitle: '全局热键说话 → 语音识别 →（可选）大模型润色 →（可选）自动插入。引擎为各端原生能力，逐步接入。',
      children: [
        _card(child: Column(children: [
          _modelPicker('语音识别（ASR）', d.asrModelId, s.asrModels, (v) { d.asrModelId = v; _save(); }),
          const SizedBox(height: 8),
          _modelPicker('润色（大模型）', d.llmModelId, s.chatModels, (v) { d.llmModelId = v; _save(); }),
        ])),
        _sectionLabel('快捷键'),
        _card(child: _field('听写热键', key: ValueKey('dic-hk'), initial: d.hotkey, hint: '如：右 Command', onChanged: (v) { d.hotkey = v; store.save(); })),
        _sectionLabel('上下文（喂给润色模型）'),
        _card(child: Column(children: [
          _field('工作语言', key: const ValueKey('dic-lang'), initial: d.workingLanguages, hint: '逗号分隔，如：中文, English', onChanged: (v) { d.workingLanguages = v; store.save(); }),
          Row(children: [
            const Text('输出语言', style: TextStyle(fontSize: 12, color: OrbitColors.textDim)),
            const SizedBox(width: 10),
            DropdownButton<String>(
              value: d.outputLanguage,
              dropdownColor: OrbitColors.panel,
              underline: const SizedBox(),
              items: const [
                DropdownMenuItem(value: 'auto', child: Text('自动')),
                DropdownMenuItem(value: 'zh', child: Text('中文')),
                DropdownMenuItem(value: 'en', child: Text('English')),
              ],
              onChanged: (v) { d.outputLanguage = v ?? 'auto'; _save(); },
            ),
          ]),
          _switchRow('感知前台应用', d.frontAppAware, (v) { d.frontAppAware = v; _save(); }),
          _switchRow('防提示词注入', d.injectionDefense, (v) { d.injectionDefense = v; _save(); }),
          _switchRow('清理模型多余输出', d.cleanOutput, (v) { d.cleanOutput = v; _save(); }),
        ])),
        _sectionLabel('行为'),
        _card(child: _switchRow('自动输入结果', d.autoInsert, (v) { d.autoInsert = v; _save(); },
            sub: '识别后自动把文字粘贴到当前光标处（需系统辅助功能权限，原生分期）')),
      ],
    );
  }

  Widget _modelPicker(String label, String? value, List<ModelConfig> models, ValueChanged<String?> onChanged) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, color: OrbitColors.textDim)),
        DropdownButton<String?>(
          value: value,
          isExpanded: true,
          underline: const SizedBox(),
          dropdownColor: OrbitColors.panel,
          items: [
            const DropdownMenuItem(value: null, child: Text('— 无 —')),
            for (final m in models)
              DropdownMenuItem(value: m.id, child: Text(m.displayName.isEmpty ? m.modelId : m.displayName)),
          ],
          onChanged: onChanged,
        ),
      ],
    );
  }
}

// ---- 截图 · 基础 ----

class CaptureBasicSection extends StatefulWidget {
  const CaptureBasicSection({super.key, required this.store});
  final SettingsStore store;
  @override
  State<CaptureBasicSection> createState() => _CaptureBasicSectionState();
}

class _CaptureBasicSectionState extends State<CaptureBasicSection> {
  SettingsStore get store => widget.store;
  CaptureSettings get c => store.settings.capture;
  void _save() { store.save(); setState(() {}); }

  @override
  Widget build(BuildContext context) {
    return SettingsScaffold(
      title: '截图 · 基础',
      subtitle: '区域截图 + 标注 + 元素级智能框选 + 贴图。屏幕捕获/元素树/热键为各端原生能力，逐步接入。',
      children: [
        _sectionLabel('快捷键'),
        _card(child: Column(children: [
          _field('区域截图', key: const ValueKey('cap-hk'), initial: c.captureHotkey, hint: 'Ctrl+Shift+A', onChanged: (v) { c.captureHotkey = v; store.save(); }),
          _field('贴到屏幕', key: const ValueKey('pin-hk'), initial: c.pinHotkey, hint: 'Ctrl+Shift+P', onChanged: (v) { c.pinHotkey = v; store.save(); }),
        ])),
        _sectionLabel('行为'),
        _card(child: Column(children: [
          _switchRow('截图后自动复制到剪贴板', c.copyAfterCapture, (v) { c.copyAfterCapture = v; _save(); }),
          _switchRow('显示快速预览', c.showQuickPreview, (v) { c.showQuickPreview = v; _save(); }),
        ])),
        _sectionLabel('AI 标注模型'),
        _card(child: DropdownButton<String?>(
          value: c.annotationModelId,
          isExpanded: true,
          underline: const SizedBox(),
          dropdownColor: OrbitColors.panel,
          items: [
            const DropdownMenuItem(value: null, child: Text('— 无 —')),
            for (final m in store.settings.chatModels)
              DropdownMenuItem(value: m.id, child: Text(m.displayName.isEmpty ? m.modelId : m.displayName)),
          ],
          onChanged: (v) { c.annotationModelId = v; _save(); },
        )),
      ],
    );
  }
}

// ---- 快捷键（汇总）----

class ShortcutsSection extends StatefulWidget {
  const ShortcutsSection({super.key, required this.store});
  final SettingsStore store;
  @override
  State<ShortcutsSection> createState() => _ShortcutsSectionState();
}

class _ShortcutsSectionState extends State<ShortcutsSection> {
  SettingsStore get store => widget.store;
  @override
  Widget build(BuildContext context) {
    final s = store.settings;
    return SettingsScaffold(
      title: '快捷键',
      subtitle: '全局快捷键在各端由原生层注册（分期接入），这里先集中配置。',
      children: [
        _card(child: Column(children: [
          _field('听写', key: const ValueKey('sc-dic'), initial: s.dictation.hotkey, onChanged: (v) { s.dictation.hotkey = v; store.save(); }),
          _field('区域截图', key: const ValueKey('sc-cap'), initial: s.capture.captureHotkey, onChanged: (v) { s.capture.captureHotkey = v; store.save(); }),
          _field('贴到屏幕', key: const ValueKey('sc-pin'), initial: s.capture.pinHotkey, onChanged: (v) { s.capture.pinHotkey = v; store.save(); }),
        ])),
      ],
    );
  }
}

// ---- 关于与权限 ----

class AboutSection extends StatelessWidget {
  const AboutSection({super.key});
  @override
  Widget build(BuildContext context) {
    return SettingsScaffold(
      title: '关于与权限',
      children: [
        _card(child: Row(children: [
          Container(
            width: 44, height: 44,
            decoration: const BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: [OrbitColors.accent, OrbitColors.accent2])),
          ),
          const SizedBox(width: 14),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
            Text('Orbit', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: OrbitColors.text)),
            SizedBox(height: 2),
            Text('开放的多模态 AI 平台 · Flutter 全端重构中', style: TextStyle(fontSize: 12.5, color: OrbitColors.textDim)),
          ]),
        ])),
        _card(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: const [
          Text('权限（各端原生分期）', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: OrbitColors.text)),
          SizedBox(height: 6),
          Text('• 麦克风 —— 听写录音\n• 辅助功能 —— 全局热键 / 自动粘贴 / 元素级框选\n• 屏幕录制 —— 截图\n这些能力依赖各平台原生插件，随功能逐步接入。',
              style: TextStyle(fontSize: 12.5, color: OrbitColors.textDim, height: 1.5)),
        ])),
      ],
    );
  }
}

// ---- 占位（功能分区，逐步补齐）----

class PlaceholderSection extends StatelessWidget {
  const PlaceholderSection({super.key, required this.title, required this.icon, required this.description});
  final String title;
  final IconData icon;
  final String description;

  @override
  Widget build(BuildContext context) {
    return SettingsScaffold(
      title: title,
      children: [
        _card(child: Row(children: [
          Icon(icon, size: 22, color: OrbitColors.accent),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Text('即将推出', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: OrbitColors.text)),
            const SizedBox(height: 4),
            Text(description, style: const TextStyle(fontSize: 12.5, color: OrbitColors.textDim, height: 1.5)),
          ])),
        ])),
      ],
    );
  }
}
