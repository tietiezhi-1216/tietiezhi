import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../chat/chat_controller.dart';
import 'theme.dart';

class ChatView extends StatefulWidget {
  const ChatView({super.key});

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _inputCtl = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _inputCtl.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _submit(ChatController chat) {
    chat.input = _inputCtl.text;
    _inputCtl.clear();
    chat.send().then((_) => _scrollToEnd());
    _scrollToEnd();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(_scroll.position.maxScrollExtent,
            duration: const Duration(milliseconds: 200), curve: Curves.easeOut);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final chat = context.watch<ChatController>();

    return Padding(
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Text('聊天',
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: OrbitColors.text)),
              const SizedBox(width: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                    color: OrbitColors.panelAlt,
                    borderRadius: BorderRadius.circular(7)),
                child: Text(chat.activeModelName,
                    style: const TextStyle(
                        fontSize: 12, color: OrbitColors.textDim)),
              ),
              const Spacer(),
              TextButton(
                  onPressed: chat.clear,
                  child: const Text('清空',
                      style: TextStyle(color: OrbitColors.textDim))),
            ],
          ),
          const SizedBox(height: 8),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              itemCount: chat.messages.length,
              itemBuilder: (_, i) => _Bubble(msg: chat.messages[i]),
            ),
          ),
          if (chat.error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(chat.error!,
                  style: const TextStyle(color: Color(0xFFF0873A))),
            ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: TextField(
                  controller: _inputCtl,
                  minLines: 1,
                  maxLines: 5,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _submit(chat),
                  decoration: const InputDecoration(hintText: '给 Orbit 发消息…'),
                ),
              ),
              const SizedBox(width: 8),
              if (chat.isStreaming)
                FilledButton.tonal(
                    onPressed: chat.stop, child: const Text('停止'))
              else
                FilledButton(
                    onPressed: () => _submit(chat),
                    child: const Text('发送')),
            ],
          ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.msg});
  final ChatUiMessage msg;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: msg.isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        constraints: const BoxConstraints(maxWidth: 600),
        decoration: BoxDecoration(
          color: msg.isUser ? OrbitColors.accent : OrbitColors.panelAlt,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(msg.roleLabel,
                style: TextStyle(
                    fontSize: 11, color: Colors.white.withValues(alpha: 0.7))),
            const SizedBox(height: 3),
            SelectableText(
              msg.text.isEmpty ? '…' : msg.text,
              style: const TextStyle(color: OrbitColors.text, fontSize: 14),
            ),
          ],
        ),
      ),
    );
  }
}
