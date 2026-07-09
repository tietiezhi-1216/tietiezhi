import 'package:flutter/material.dart';

import 'chat_view.dart';
import 'settings_view.dart';
import 'theme.dart';

/// The single-window shell: a slim left rail (chat / settings) beside the content,
/// mirroring the macOS app's single-window dual-workspace.
class OrbitShell extends StatefulWidget {
  const OrbitShell({super.key});

  @override
  State<OrbitShell> createState() => _OrbitShellState();
}

class _OrbitShellState extends State<OrbitShell> {
  int _index = 0; // 0 = chat, 1 = settings

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Row(
        children: [
          _Rail(index: _index, onSelect: (i) => setState(() => _index = i)),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: const [ChatView(), SettingsView()],
            ),
          ),
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
        color: OrbitColors.panel,
        border: Border(right: BorderSide(color: OrbitColors.border)),
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
                colors: [OrbitColors.accent, OrbitColors.accent2],
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
            icon: Icons.settings_outlined,
            label: '设置',
            active: index == 1,
            onTap: () => onSelect(1),
          ),
        ],
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
        color: active ? OrbitColors.panelAlt : Colors.transparent,
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
                    color: active ? OrbitColors.text : OrbitColors.textDim),
                const SizedBox(height: 2),
                Text(label,
                    style: TextStyle(
                        fontSize: 10,
                        color: active ? OrbitColors.text : OrbitColors.textDim)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
