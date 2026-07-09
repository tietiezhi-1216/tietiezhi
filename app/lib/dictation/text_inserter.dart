import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Delivers recognized text to the user. Ported in spirit from the macOS
/// TextInserter (clipboard + synthesized ⌘V). Cross-platform reality:
///  - Everywhere: the transcript is written to the system clipboard.
///  - Auto-paste into the *focused* app needs OS-native key synthesis
///    (⌘V / Ctrl+V) and Accessibility permission; that is a per-platform native
///    step wired incrementally (see [autoPasteSupported]). Until then the pill
///    tells the user it's copied.
class TextInserter {
  /// Whether synthesized-paste is wired for the current platform yet.
  /// (Desktop targets are where it will land first; not yet implemented.)
  static bool get autoPasteSupported => false;

  /// Copy [text] to the clipboard. Returns true on success.
  static Future<bool> copy(String text) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      return true;
    } catch (e) {
      if (kDebugMode) debugPrint('[dictation] clipboard 写入失败: $e');
      return false;
    }
  }

  /// Deliver [text]: copy to clipboard, and (when supported + requested) paste
  /// into the focused app. Returns a short human status for the pill.
  static Future<String> deliver(String text, {required bool autoInsert}) async {
    final copied = await copy(text);
    if (!copied) return '复制失败';
    if (autoInsert && autoPasteSupported) {
      // Native paste synthesis will hook in here per platform.
      return '已插入';
    }
    return '已复制，⌘/Ctrl+V 粘贴';
  }
}
