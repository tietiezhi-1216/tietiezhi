import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/settings_store.dart';
import '../theme.dart';
import 'sections.dart';

// 两级分类（对齐 Swift 版 SettingsSection）：组 → 分区。
enum SettingsGroup { access, capabilities, dictation, capture, personalization, system }

extension SettingsGroupX on SettingsGroup {
  String get title => switch (this) {
        SettingsGroup.access => '模型服务',
        SettingsGroup.capabilities => '功能',
        SettingsGroup.dictation => '听写',
        SettingsGroup.capture => '截图',
        SettingsGroup.personalization => '个性化',
        SettingsGroup.system => '系统',
      };
}

enum SettingsSection {
  providers,
  usage,
  agents,
  tools,
  mcp,
  skills,
  dictationBasic,
  dictationModes,
  dictationVocab,
  dictationHistory,
  dictationStats,
  captureBasic,
  captureHistory,
  shortcuts,
  feedbackSounds,
  about,
}

extension SettingsSectionX on SettingsSection {
  String get title => switch (this) {
        SettingsSection.providers => '渠道商',
        SettingsSection.usage => '用量',
        SettingsSection.agents => '智能体',
        SettingsSection.tools => '工具',
        SettingsSection.mcp => 'MCP',
        SettingsSection.skills => '技能',
        SettingsSection.dictationBasic => '基础',
        SettingsSection.dictationModes => '模板',
        SettingsSection.dictationVocab => '词汇',
        SettingsSection.dictationHistory => '历史',
        SettingsSection.dictationStats => '统计',
        SettingsSection.captureBasic => '基础',
        SettingsSection.captureHistory => '历史',
        SettingsSection.shortcuts => '快捷键',
        SettingsSection.feedbackSounds => '提示音',
        SettingsSection.about => '关于与权限',
      };

  IconData get icon => switch (this) {
        SettingsSection.providers => Icons.dns_outlined,
        SettingsSection.usage => Icons.pie_chart_outline,
        SettingsSection.agents => Icons.smart_toy_outlined,
        SettingsSection.tools => Icons.build_outlined,
        SettingsSection.mcp => Icons.extension_outlined,
        SettingsSection.skills => Icons.auto_awesome_outlined,
        SettingsSection.dictationBasic => Icons.mic_none_outlined,
        SettingsSection.dictationModes => Icons.tune_outlined,
        SettingsSection.dictationVocab => Icons.spellcheck_outlined,
        SettingsSection.dictationHistory => Icons.history_outlined,
        SettingsSection.dictationStats => Icons.bar_chart_outlined,
        SettingsSection.captureBasic => Icons.crop_outlined,
        SettingsSection.captureHistory => Icons.photo_library_outlined,
        SettingsSection.shortcuts => Icons.keyboard_outlined,
        SettingsSection.feedbackSounds => Icons.volume_up_outlined,
        SettingsSection.about => Icons.info_outline,
      };

  SettingsGroup get group => switch (this) {
        SettingsSection.providers || SettingsSection.usage => SettingsGroup.access,
        SettingsSection.agents ||
        SettingsSection.tools ||
        SettingsSection.mcp ||
        SettingsSection.skills =>
          SettingsGroup.capabilities,
        SettingsSection.dictationBasic ||
        SettingsSection.dictationModes ||
        SettingsSection.dictationVocab ||
        SettingsSection.dictationHistory ||
        SettingsSection.dictationStats =>
          SettingsGroup.dictation,
        SettingsSection.captureBasic || SettingsSection.captureHistory => SettingsGroup.capture,
        SettingsSection.shortcuts || SettingsSection.feedbackSounds =>
          SettingsGroup.personalization,
        SettingsSection.about => SettingsGroup.system,
      };
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  SettingsSection _section = SettingsSection.providers;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _SettingsSidebar(
          selected: _section,
          onSelect: (s) => setState(() => _section = s),
        ),
        const VerticalDivider(width: 1, color: OrbitColors.border),
        Expanded(child: _detail(_section)),
      ],
    );
  }

  Widget _detail(SettingsSection s) {
    final store = context.read<SettingsStore>();
    return switch (s) {
      SettingsSection.providers => ProvidersSection(store: store),
      SettingsSection.dictationBasic => DictationBasicSection(store: store),
      SettingsSection.captureBasic => CaptureBasicSection(store: store),
      SettingsSection.shortcuts => ShortcutsSection(store: store),
      SettingsSection.about => const AboutSection(),
      _ => PlaceholderSection(title: s.title, icon: s.icon, description: _desc(s)),
    };
  }

  String _desc(SettingsSection s) => switch (s) {
        SettingsSection.usage => '按厂商 / 模型统计 token 用量与花费。',
        SettingsSection.agents => '预设「智能体」——为不同任务配置系统提示词、工具与默认模型。',
        SettingsSection.tools => '对话可调用的工具（函数）——启用/禁用、查看参数。',
        SettingsSection.mcp => '接入 MCP 服务器，把外部能力接进对话。',
        SettingsSection.skills => '技能——把常用流程封装成一键调用的指令。',
        SettingsSection.dictationModes => '听写模板：为不同场景（邮件 / 代码 / 会议）定制润色风格。',
        SettingsSection.dictationVocab => '自定义词汇：让识别更准地认出专有名词。',
        SettingsSection.dictationHistory => '历史转写记录，可回看、复制、重润色。',
        SettingsSection.dictationStats => '听写用量统计：字数、时长、常用词。',
        SettingsSection.captureHistory => '截图历史：回看、复制、重新编辑标注。',
        SettingsSection.feedbackSounds => '提示音：录音开始 / 结束 / 完成的声音反馈。',
        _ => '此功能开发中。',
      };
}

class _SettingsSidebar extends StatelessWidget {
  const _SettingsSidebar({required this.selected, required this.onSelect});
  final SettingsSection selected;
  final ValueChanged<SettingsSection> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 190,
      color: OrbitColors.panel,
      child: ListView(
        padding: const EdgeInsets.symmetric(vertical: 12),
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 4, 16, 10),
            child: Text('设置',
                style: TextStyle(
                    fontSize: 16, fontWeight: FontWeight.w700, color: OrbitColors.text)),
          ),
          for (final group in SettingsGroup.values) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text(group.title,
                  style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.5,
                      color: OrbitColors.textDim)),
            ),
            for (final s in SettingsSection.values.where((s) => s.group == group))
              _SectionTile(
                section: s,
                active: s == selected,
                onTap: () => onSelect(s),
              ),
          ],
        ],
      ),
    );
  }
}

class _SectionTile extends StatelessWidget {
  const _SectionTile({required this.section, required this.active, required this.onTap});
  final SettingsSection section;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      child: Material(
        color: active ? OrbitColors.panelAlt : Colors.transparent,
        borderRadius: BorderRadius.circular(7),
        child: InkWell(
          borderRadius: BorderRadius.circular(7),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            child: Row(
              children: [
                Icon(section.icon,
                    size: 16, color: active ? OrbitColors.accent : OrbitColors.textDim),
                const SizedBox(width: 8),
                Text(section.title,
                    style: TextStyle(
                        fontSize: 13,
                        color: active ? OrbitColors.text : OrbitColors.textDim)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
