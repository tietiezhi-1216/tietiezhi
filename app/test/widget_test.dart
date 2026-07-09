import 'package:flutter_test/flutter_test.dart';

import 'package:orbit/core/models.dart';

void main() {
  test('resolved model builds the endpoint URL from provider + wire', () {
    final p = ApiProvider(baseUrl: 'https://api.openai.com/v1/');
    final m = ModelConfig(providerId: p.id, wire: Wire.openaiChat);
    final s = Settings(providers: [p], models: [m], activeChatModelId: m.id);
    final r = s.resolve(m)!;
    expect(r.url, 'https://api.openai.com/v1/chat/completions');
  });
}
