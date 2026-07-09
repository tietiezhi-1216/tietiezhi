import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';

/// Registers a system-wide hotkey to toggle dictation, on desktop only.
/// On web/mobile there is no global hotkey — the mic button in the rail is the
/// trigger. Default binding: Alt/Option + Space (custom binding UI is a refine).
class DictationHotkey {
  static bool get supported =>
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.macOS ||
          defaultTargetPlatform == TargetPlatform.windows ||
          defaultTargetPlatform == TargetPlatform.linux);

  static final HotKey _hotKey = HotKey(
    key: PhysicalKeyboardKey.space,
    modifiers: [HotKeyModifier.alt],
    scope: HotKeyScope.system,
  );

  /// Human label for the current binding (for settings/UI copy).
  static String get label => 'Alt/Option + Space';

  static Future<void> register(VoidCallback onTrigger) async {
    if (!supported) return;
    try {
      await hotKeyManager.unregisterAll();
      await hotKeyManager.register(_hotKey, keyDownHandler: (_) => onTrigger());
    } catch (e) {
      if (kDebugMode) debugPrint('[dictation] 全局热键注册失败: $e');
    }
  }

  static Future<void> unregister() async {
    if (!supported) return;
    try {
      await hotKeyManager.unregisterAll();
    } catch (_) {}
  }
}
