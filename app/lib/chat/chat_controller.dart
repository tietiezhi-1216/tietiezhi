import 'package:flutter/foundation.dart';

import '../core/chat_client.dart';
import '../core/settings_store.dart';

class ChatUiMessage {
  final String role; // 'user' | 'assistant'
  String text;
  ChatUiMessage(this.role, this.text);
  bool get isUser => role == 'user';
  String get roleLabel => isUser ? '你' : 'Orbit';
}

class ChatController extends ChangeNotifier {
  final SettingsStore store;
  final ChatClient _client = ChatClient();

  final List<ChatUiMessage> messages = [];
  String input = '';
  bool isStreaming = false;
  String? error;
  bool _cancel = false;

  ChatController(this.store);

  String get activeModelName =>
      store.settings.activeChatModel?.displayName ?? '未配置模型';

  Future<void> send() async {
    final text = input.trim();
    if (text.isEmpty || isStreaming) return;

    final resolved = store.settings.resolve(store.settings.activeChatModel);
    if (resolved == null) {
      error = '未配置可用的聊天模型，请到「设置」里填好厂商 Base URL / API Key。';
      notifyListeners();
      return;
    }

    error = null;
    messages.add(ChatUiMessage('user', text));
    input = '';
    final assistant = ChatUiMessage('assistant', '');
    messages.add(assistant);
    isStreaming = true;
    _cancel = false;
    notifyListeners();

    try {
      final history = messages
          .where((m) => !identical(m, assistant))
          .map((m) => ChatMessage(m.role, m.text))
          .toList();
      await for (final delta in _client.stream(resolved, history)) {
        if (_cancel) break;
        assistant.text += delta;
        notifyListeners();
      }
    } catch (e) {
      error = e.toString();
      if (assistant.text.isEmpty) messages.remove(assistant);
    } finally {
      isStreaming = false;
      notifyListeners();
    }
  }

  void stop() {
    _cancel = true;
  }

  void clear() {
    _cancel = true;
    messages.clear();
    error = null;
    notifyListeners();
  }
}
