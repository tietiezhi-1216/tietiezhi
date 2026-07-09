// Orbit config domain model — ported from the macOS app (Models/Settings.swift).
// Layering is deliberate and shared across every platform:
//   ApiProvider (厂商: baseUrl + apiKey + auth)
//     └─ ModelConfig (具体模型) —— 挂到某厂商，声明自己走哪种 Wire
//          └─ Wire (归一化协议规格: 端点路径 + 请求体 + 流解析)
// A model never carries a hand-typed URL; the endpoint path comes from its Wire,
// auth from its ApiProvider. `Settings.resolve(model)` packs everything a network
// call needs into a ResolvedModel.

/// A normalized protocol spec — decides endpoint path, request body and stream parse.
enum Wire { openaiChat, openaiResponses, anthropicMessages, whisper }

extension WireX on Wire {
  String get id => switch (this) {
        Wire.openaiChat => 'openaiChat',
        Wire.openaiResponses => 'openaiResponses',
        Wire.anthropicMessages => 'anthropicMessages',
        Wire.whisper => 'whisper',
      };

  String get displayName => switch (this) {
        Wire.openaiChat => 'OpenAI Chat',
        Wire.openaiResponses => 'OpenAI Responses',
        Wire.anthropicMessages => 'Anthropic Messages',
        Wire.whisper => 'Whisper（语音识别）',
      };

  String get defaultPath => switch (this) {
        Wire.openaiChat => '/chat/completions',
        Wire.openaiResponses => '/responses',
        Wire.anthropicMessages => '/messages',
        Wire.whisper => '/audio/transcriptions',
      };

  static Wire fromId(String? s) =>
      Wire.values.firstWhere((w) => w.id == s, orElse: () => Wire.openaiChat);
}

enum AuthScheme { bearer, anthropic, apiKey }

extension AuthSchemeX on AuthScheme {
  String get displayName => switch (this) {
        AuthScheme.bearer => 'Bearer',
        AuthScheme.anthropic => 'Anthropic（x-api-key）',
        AuthScheme.apiKey => 'api-key',
      };

  static AuthScheme fromId(String? s) =>
      AuthScheme.values.firstWhere((a) => a.name == s, orElse: () => AuthScheme.bearer);
}

int _idCounter = 0;
String _newId() {
  // Monotonic-ish local id; good enough for config entries (not persisted-order sensitive).
  _idCounter += 1;
  return '${DateTime.now().microsecondsSinceEpoch}_$_idCounter';
}

/// 厂商 / 渠道: base URL + credentials.
class ApiProvider {
  String id;
  String name;
  String baseUrl;
  String apiKey;
  AuthScheme auth;

  ApiProvider({
    String? id,
    this.name = '',
    this.baseUrl = '',
    this.apiKey = '',
    this.auth = AuthScheme.bearer,
  }) : id = id ?? _newId();

  factory ApiProvider.fromJson(Map<String, dynamic> j) => ApiProvider(
        id: j['id'] as String?,
        name: j['name'] as String? ?? '',
        baseUrl: j['baseUrl'] as String? ?? '',
        apiKey: j['apiKey'] as String? ?? '',
        auth: AuthSchemeX.fromId(j['auth'] as String?),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'baseUrl': baseUrl,
        'apiKey': apiKey,
        'auth': auth.name,
      };
}

class ModelConfig {
  String id;
  String providerId;

  /// The model name the API expects (e.g. "gpt-4o", "claude-sonnet-4").
  String modelId;
  String displayName;
  Wire wire;

  ModelConfig({
    String? id,
    this.providerId = '',
    this.modelId = '',
    this.displayName = '',
    this.wire = Wire.openaiChat,
  }) : id = id ?? _newId();

  factory ModelConfig.fromJson(Map<String, dynamic> j) => ModelConfig(
        id: j['id'] as String?,
        providerId: j['providerId'] as String? ?? '',
        modelId: j['modelId'] as String? ?? '',
        displayName: j['displayName'] as String? ?? '',
        wire: WireX.fromId(j['wire'] as String?),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'providerId': providerId,
        'modelId': modelId,
        'displayName': displayName,
        'wire': wire.id,
      };
}

/// The whole persisted config document.
class Settings {
  List<ApiProvider> providers;
  List<ModelConfig> models;
  String? activeChatModelId;

  Settings({
    List<ApiProvider>? providers,
    List<ModelConfig>? models,
    this.activeChatModelId,
  })  : providers = providers ?? [],
        models = models ?? [];

  factory Settings.fromJson(Map<String, dynamic> j) => Settings(
        providers: (j['providers'] as List? ?? [])
            .map((e) => ApiProvider.fromJson(e as Map<String, dynamic>))
            .toList(),
        models: (j['models'] as List? ?? [])
            .map((e) => ModelConfig.fromJson(e as Map<String, dynamic>))
            .toList(),
        activeChatModelId: j['activeChatModelId'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'providers': providers.map((p) => p.toJson()).toList(),
        'models': models.map((m) => m.toJson()).toList(),
        'activeChatModelId': activeChatModelId,
      };

  ModelConfig? get activeChatModel {
    for (final m in models) {
      if (m.id == activeChatModelId) return m;
    }
    return models.isNotEmpty ? models.first : null;
  }

  ApiProvider? providerFor(ModelConfig model) {
    for (final p in providers) {
      if (p.id == model.providerId) return p;
    }
    return null;
  }

  ResolvedModel? resolve(ModelConfig? model) {
    if (model == null) return null;
    final provider = providerFor(model);
    if (provider == null) return null;
    return ResolvedModel(model, provider);
  }

  /// First-run starter so the app is usable immediately.
  factory Settings.seed() {
    final p = ApiProvider(
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      auth: AuthScheme.bearer,
    );
    final m = ModelConfig(
      providerId: p.id,
      modelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
      wire: Wire.openaiChat,
    );
    return Settings(providers: [p], models: [m], activeChatModelId: m.id);
  }
}

/// A model + provider flattened into everything a network call needs.
class ResolvedModel {
  final ModelConfig model;
  final ApiProvider provider;

  ResolvedModel(this.model, this.provider);

  Wire get wire => model.wire;
  String get modelId => model.modelId;

  String get url {
    var b = provider.baseUrl.trim();
    while (b.endsWith('/')) {
      b = b.substring(0, b.length - 1);
    }
    return '$b${wire.defaultPath}';
  }

  Map<String, String> authHeaders() {
    switch (provider.auth) {
      case AuthScheme.bearer:
        return {'Authorization': 'Bearer ${provider.apiKey}'};
      case AuthScheme.anthropic:
        return {'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01'};
      case AuthScheme.apiKey:
        return {'api-key': provider.apiKey};
    }
  }
}
