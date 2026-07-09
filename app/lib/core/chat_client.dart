import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

class ChatException implements Exception {
  final String message;
  ChatException(this.message);
  @override
  String toString() => message;
}

/// One turn's message, as sent to the API.
class ChatMessage {
  final String role; // 'system' | 'user' | 'assistant'
  final String text;
  ChatMessage(this.role, this.text);
}

/// Streaming chat. Branches by Wire to build the request body and parse the SSE
/// stream (OpenAI Chat and Anthropic Messages are both `data: {json}` lines, only
/// the body + chunk shape differ). Ported from the macOS ChatClient.stream.
class ChatClient {
  final http.Client _client = http.Client();

  Stream<String> stream(ResolvedModel r, List<ChatMessage> messages) async* {
    final req = http.Request('POST', Uri.parse(r.url));
    req.headers.addAll({'Content-Type': 'application/json', ...r.authHeaders()});
    req.body = _buildBody(r, messages);

    final resp = await _client.send(req);
    if (resp.statusCode >= 400) {
      final body = await resp.stream.bytesToString();
      final snippet = body.length > 600 ? body.substring(0, 600) : body;
      throw ChatException('${resp.statusCode}: $snippet');
    }

    final lines =
        resp.stream.transform(utf8.decoder).transform(const LineSplitter());
    await for (final line in lines) {
      if (!line.startsWith('data:')) continue;
      final data = line.substring(5).trim();
      if (data == '[DONE]') break;
      final delta = _parseDelta(r.wire, data);
      if (delta != null && delta.isNotEmpty) yield delta;
    }
  }

  String _buildBody(ResolvedModel r, List<ChatMessage> messages) {
    if (r.wire == Wire.anthropicMessages) {
      final system = messages
          .where((m) => m.role == 'system')
          .map((m) => m.text)
          .join('\n');
      final msgs = messages
          .where((m) => m.role != 'system')
          .map((m) => {
                'role': m.role == 'assistant' ? 'assistant' : 'user',
                'content': m.text,
              })
          .toList();
      return jsonEncode({
        'model': r.modelId,
        'max_tokens': 4096,
        if (system.isNotEmpty) 'system': system,
        'messages': msgs,
        'stream': true,
      });
    }

    final msgs =
        messages.map((m) => {'role': m.role, 'content': m.text}).toList();
    return jsonEncode({'model': r.modelId, 'messages': msgs, 'stream': true});
  }

  String? _parseDelta(Wire wire, String data) {
    try {
      final j = jsonDecode(data) as Map<String, dynamic>;
      if (wire == Wire.anthropicMessages) {
        if (j['type'] == 'content_block_delta') {
          return (j['delta'] as Map<String, dynamic>?)?['text'] as String?;
        }
        return null;
      }
      final choices = j['choices'];
      if (choices is List && choices.isNotEmpty) {
        final delta = (choices[0] as Map<String, dynamic>)['delta'];
        return (delta as Map<String, dynamic>?)?['content'] as String?;
      }
      return null;
    } catch (_) {
      return null;
    }
  }
}
