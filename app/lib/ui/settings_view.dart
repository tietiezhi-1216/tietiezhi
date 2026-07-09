import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/models.dart';
import '../core/settings_store.dart';
import 'theme.dart';

class SettingsView extends StatefulWidget {
  const SettingsView({super.key});

  @override
  State<SettingsView> createState() => _SettingsViewState();
}

class _SettingsViewState extends State<SettingsView> {
  ModelConfig? _selected;

  @override
  Widget build(BuildContext context) {
    final store = context.watch<SettingsStore>();
    final s = store.settings;
    _selected ??= s.activeChatModel;
    // Keep the selection valid if the model list changed.
    if (_selected != null && !s.models.contains(_selected)) {
      _selected = s.activeChatModel;
    }
    final model = _selected;
    final provider = model == null ? null : s.providerFor(model);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(18),
      child: Align(
        alignment: Alignment.topLeft,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _header('设置'),
              const SizedBox(height: 8),
              _label('当前聊天模型'),
              DropdownButton<ModelConfig>(
                value: model,
                isExpanded: true,
                dropdownColor: OrbitColors.panel,
                items: [
                  for (final m in s.models)
                    DropdownMenuItem(value: m, child: Text(m.displayName)),
                ],
                onChanged: (m) => setState(() => _selected = m),
              ),
              if (provider != null) ...[
                const SizedBox(height: 16),
                _header('厂商', size: 13),
                _text(model!.id, '名称', provider.name, (v) => provider.name = v),
                _text(model.id, 'Base URL', provider.baseUrl,
                    (v) => provider.baseUrl = v,
                    hint: 'https://api.openai.com/v1'),
                _text(model.id, 'API Key', provider.apiKey,
                    (v) => provider.apiKey = v,
                    obscure: true),
                _label('鉴权方式'),
                DropdownButton<AuthScheme>(
                  value: provider.auth,
                  isExpanded: true,
                  dropdownColor: OrbitColors.panel,
                  items: [
                    for (final a in AuthScheme.values)
                      DropdownMenuItem(value: a, child: Text(a.displayName)),
                  ],
                  onChanged: (a) =>
                      setState(() => provider.auth = a ?? provider.auth),
                ),
              ],
              if (model != null) ...[
                const SizedBox(height: 16),
                _header('模型', size: 13),
                _text(model.id, '显示名', model.displayName,
                    (v) => model.displayName = v),
                _text(model.id, '模型 ID（API 名）', model.modelId,
                    (v) => model.modelId = v,
                    hint: 'gpt-4o-mini'),
                _label('协议（Wire）'),
                DropdownButton<Wire>(
                  value: model.wire,
                  isExpanded: true,
                  dropdownColor: OrbitColors.panel,
                  items: [
                    for (final w in Wire.values)
                      DropdownMenuItem(value: w, child: Text(w.displayName)),
                  ],
                  onChanged: (w) => setState(() => model.wire = w ?? model.wire),
                ),
              ],
              const SizedBox(height: 18),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton(
                    onPressed: () {
                      store.addProvider();
                      setState(() => _selected = store.settings.activeChatModel);
                    },
                    child: const Text('新增厂商'),
                  ),
                  OutlinedButton(
                    onPressed: () {
                      store.addModel(provider?.id);
                      setState(() => _selected = store.settings.activeChatModel);
                    },
                    child: const Text('新增模型'),
                  ),
                  FilledButton(
                    onPressed: () {
                      if (model != null) {
                        store.settings.activeChatModelId = model.id;
                      }
                      store.save();
                      ScaffoldMessenger.of(context).showSnackBar(
                        const SnackBar(content: Text('已保存')),
                      );
                    },
                    child: const Text('保存'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _header(String t, {double size = 15}) => Text(t,
      style: TextStyle(
          fontSize: size,
          fontWeight: FontWeight.w600,
          color: OrbitColors.text));

  Widget _label(String t) => Padding(
        padding: const EdgeInsets.only(top: 12, bottom: 4),
        child: Text(t,
            style: const TextStyle(fontSize: 12, color: OrbitColors.textDim)),
      );

  Widget _text(String modelId, String label, String value,
      ValueChanged<String> onChanged,
      {String? hint, bool obscure = false}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _label(label),
          TextFormField(
            // Fresh field when the selected model changes.
            key: ValueKey('$modelId-$label'),
            initialValue: value,
            obscureText: obscure,
            onChanged: onChanged,
            decoration: InputDecoration(hintText: hint),
          ),
        ],
      ),
    );
  }
}
