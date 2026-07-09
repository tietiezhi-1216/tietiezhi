import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../dictation/dictation_controller.dart';
import '../dictation/dictation_hotkey.dart';
import 'chat_view.dart';
import 'dictation_pill.dart';
import 'interconnect_view.dart';
import 'settings/settings_page.dart';
import 'theme.dart';

/// The single-window shell: a slim left rail (chat / 互联 / settings) beside the
/// content, plus a mic action that toggles dictation, and the floating pill
/// overlay. Mirrors the macOS app's single-window multi-workspace.
class TietiezhiShell extends StatefulWidget {
  const TietiezhiShell({super.key});

  @override
  State<TietiezhiShell> createState() => _TietiezhiShellState();
}

class _TietiezhiShellState extends State<TietiezhiShell> {
  int _index = 0; // 0 = chat, 1 = interconnect, 2 = settings

  @override
  void initState() {
    super.initState();
    // Register the global dictation hotkey (desktop only) once the tree is up.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final dictation = context.read<DictationController>();
      DictationHotkey.register(dictation.toggle);
    });
  }

  @override
  void dispose() {
    DictationHotkey.unregister();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          Row(
            children: [
              _Rail(index: _index, onSelect: (i) => setState(() => _index = i)),
              Expanded(
                child: IndexedStack(
                  index: _index,
                  children: const [ChatView(), InterconnectView(), SettingsPage()],
                ),
              ),
            ],
          ),
          const DictationPill(),
        ],
      ),
    );
  }
}

class _Rail extends StatelessWidget {
  const _Rail({required this.index, required this.onSelect});
  final int index;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 60,
      decoration: const BoxDecoration(
        color: TietiezhiColors.panel,
        border: Border(right: BorderSide(color: TietiezhiColors.border)),
      ),
      child: Column(
        children: [
          const SizedBox(height: 16),
          Container(
            width: 24,
            height: 24,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                colors: [TietiezhiColors.accent, TietiezhiColors.accent2],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
            ),
          ),
          const SizedBox(height: 16),
          _RailButton(
            icon: Icons.chat_bubble_outline,
            label: '聊天',
            active: index == 0,
            onTap: () => onSelect(0),
          ),
          _RailButton(
            icon: Icons.hub_outlined,
            label: '互联',
            active: index == 1,
            onTap: () => onSelect(1),
          ),
          _RailButton(
            icon: Icons.settings_outlined,
            label: '设置',
            active: index == 2,
            onTap: () => onSelect(2),
          ),
          const Spacer(),
          const _MicButton(),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

/// Toggles dictation; turns red while recording. Works on every platform
/// (the global hotkey is a desktop-only extra).
class _MicButton extends StatelessWidget {
  const _MicButton();

  @override
  Widget build(BuildContext context) {
    final c = context.watch<DictationController>();
    final recording = c.isRecording;
    final busy = c.phase == DictationPhase.transcribing ||
        c.phase == DictationPhase.polishing;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
      child: Material(
        color: recording ? const Color(0x33EF4444) : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: busy ? null : () => c.toggle(),
          child: SizedBox(
            width: 44,
            height: 46,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(
                  recording ? Icons.stop_circle : Icons.mic_none,
                  size: 20,
                  color: recording ? const Color(0xFFEF4444) : TietiezhiColors.textDim,
                ),
                const SizedBox(height: 2),
                Text('听写',
                    style: TextStyle(
                        fontSize: 10,
                        color: recording ? const Color(0xFFEF4444) : TietiezhiColors.textDim)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RailButton extends StatelessWidget {
  const _RailButton({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
  });
  final IconData icon;
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
      child: Material(
        color: active ? TietiezhiColors.panelAlt : Colors.transparent,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: onTap,
          child: SizedBox(
            width: 44,
            height: 46,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon,
                    size: 18,
                    color: active ? TietiezhiColors.text : TietiezhiColors.textDim),
                const SizedBox(height: 2),
                Text(label,
                    style: TextStyle(
                        fontSize: 10,
                        color: active ? TietiezhiColors.text : TietiezhiColors.textDim)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
