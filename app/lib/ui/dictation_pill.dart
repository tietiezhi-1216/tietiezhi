import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../dictation/dictation_controller.dart';
import 'theme.dart';

/// The floating dictation capsule, mirroring the macOS pill: live mic level while
/// recording, a spinner through ASR/polish, the result on done, errors on fail.
/// Rendered as an in-app bottom-center overlay (a true always-on-top OS panel is
/// a later native refinement). Hidden when idle.
class DictationPill extends StatelessWidget {
  const DictationPill({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.watch<DictationController>();
    if (c.phase == DictationPhase.idle) return const SizedBox.shrink();

    return Positioned(
      left: 0,
      right: 0,
      bottom: 28,
      child: Center(
        child: Material(
          color: Colors.transparent,
          child: Container(
            constraints: const BoxConstraints(maxWidth: 460),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: TietiezhiColors.panel,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(color: TietiezhiColors.border),
              boxShadow: const [
                BoxShadow(color: Color(0x66000000), blurRadius: 24, offset: Offset(0, 8)),
              ],
            ),
            child: _content(context, c),
          ),
        ),
      ),
    );
  }

  Widget _content(BuildContext context, DictationController c) {
    switch (c.phase) {
      case DictationPhase.recording:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _dot(const Color(0xFFEF4444)),
            const SizedBox(width: 12),
            _LevelBars(level: c.level),
            const SizedBox(width: 12),
            const Text('聆听中 · 再按结束',
                style: TextStyle(color: TietiezhiColors.text, fontSize: 13)),
            const SizedBox(width: 8),
            _iconBtn(Icons.close, '取消', () => c.cancel()),
          ],
        );
      case DictationPhase.transcribing:
        return _spinnerRow('识别中…');
      case DictationPhase.polishing:
        return _spinnerRow('润色中…');
      case DictationPhase.done:
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(mainAxisSize: MainAxisSize.min, children: [
              const Icon(Icons.check_circle, color: Color(0xFF22C55E), size: 16),
              const SizedBox(width: 6),
              Text(c.statusText,
                  style: const TextStyle(color: TietiezhiColors.textDim, fontSize: 12)),
            ]),
            if (c.resultText.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                c.resultText,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: TietiezhiColors.text, fontSize: 14),
              ),
            ],
          ],
        );
      case DictationPhase.error:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: Color(0xFFF59E0B), size: 16),
            const SizedBox(width: 8),
            Flexible(
              child: Text(c.errorText ?? '出错了',
                  style: const TextStyle(color: TietiezhiColors.text, fontSize: 13)),
            ),
          ],
        );
      case DictationPhase.idle:
        return const SizedBox.shrink();
    }
  }

  Widget _spinnerRow(String label) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: TietiezhiColors.accent),
          ),
          const SizedBox(width: 12),
          Text(label, style: const TextStyle(color: TietiezhiColors.text, fontSize: 13)),
        ],
      );

  Widget _dot(Color color) =>
      Container(width: 9, height: 9, decoration: BoxDecoration(color: color, shape: BoxShape.circle));

  Widget _iconBtn(IconData icon, String tip, VoidCallback onTap) => IconButton(
        icon: Icon(icon, size: 16, color: TietiezhiColors.textDim),
        tooltip: tip,
        visualDensity: VisualDensity.compact,
        onPressed: onTap,
      );
}

/// A little animated level meter (five bars) reacting to the mic level.
class _LevelBars extends StatelessWidget {
  const _LevelBars({required this.level});
  final double level;

  @override
  Widget build(BuildContext context) {
    const bars = 5;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(bars, (i) {
        final threshold = (i + 1) / bars;
        final on = level >= threshold * 0.9 || (i == 0 && level > 0.02);
        final h = 6.0 + i * 3.0;
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 1.5),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 90),
            width: 3.5,
            height: on ? h + 6 : h,
            decoration: BoxDecoration(
              color: on ? TietiezhiColors.accent : TietiezhiColors.border,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        );
      }),
    );
  }
}
