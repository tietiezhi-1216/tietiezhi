// Tietiezhi config domain model — ported from the macOS app (Models/Settings.swift).
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

  Capability get capability => switch (this) {
        Wire.whisper => Capability.asr,
        _ => Capability.chat,
      };

  static Wire fromId(String? s) =>
      Wire.values.firstWhere((w) => w.id == s, orElse: () => Wire.openaiChat);
}

enum Capability { chat, asr, embedding, image, video, tts, rerank }

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

  Capability get capability => wire.capability;
}

/// 听写（语音胶囊）设置——引擎（音频采集/ASR/润色/插入）是原生分期，这里先是配置。
class DictationSettings {
  String? asrModelId; // 语音识别模型（wire=whisper）
  String? llmModelId; // 润色模型（chat）
  String hotkey; // 全局热键（跨端注册为原生能力，先存标签）
  String workingLanguages; // 逗号分隔
  String outputLanguage; // auto / zh / en …
  bool frontAppAware;
  bool injectionDefense;
  bool cleanOutput;
  bool autoInsert;

  DictationSettings({
    this.asrModelId,
    this.llmModelId,
    this.hotkey = '右 Command',
    this.workingLanguages = '中文, English',
    this.outputLanguage = 'auto',
    this.frontAppAware = true,
    this.injectionDefense = true,
    this.cleanOutput = true,
    this.autoInsert = true,
  });

  factory DictationSettings.fromJson(Map<String, dynamic> j) => DictationSettings(
        asrModelId: j['asrModelId'] as String?,
        llmModelId: j['llmModelId'] as String?,
        hotkey: j['hotkey'] as String? ?? '右 Command',
        workingLanguages: j['workingLanguages'] as String? ?? '中文, English',
        outputLanguage: j['outputLanguage'] as String? ?? 'auto',
        frontAppAware: j['frontAppAware'] as bool? ?? true,
        injectionDefense: j['injectionDefense'] as bool? ?? true,
        cleanOutput: j['cleanOutput'] as bool? ?? true,
        autoInsert: j['autoInsert'] as bool? ?? true,
      );

  Map<String, dynamic> toJson() => {
        'asrModelId': asrModelId,
        'llmModelId': llmModelId,
        'hotkey': hotkey,
        'workingLanguages': workingLanguages,
        'outputLanguage': outputLanguage,
        'frontAppAware': frontAppAware,
        'injectionDefense': injectionDefense,
        'cleanOutput': cleanOutput,
        'autoInsert': autoInsert,
      };
}

/// 截图设置——同样引擎（屏幕捕获/标注/元素框选）是原生分期。
class CaptureSettings {
  String captureHotkey;
  String pinHotkey;
  bool copyAfterCapture;
  bool showQuickPreview;
  String? annotationModelId; // AI 标注用的多模态模型

  CaptureSettings({
    this.captureHotkey = 'Ctrl+Shift+A',
    this.pinHotkey = 'Ctrl+Shift+P',
    this.copyAfterCapture = true,
    this.showQuickPreview = true,
    this.annotationModelId,
  });

  factory CaptureSettings.fromJson(Map<String, dynamic> j) => CaptureSettings(
        captureHotkey: j['captureHotkey'] as String? ?? 'Ctrl+Shift+A',
        pinHotkey: j['pinHotkey'] as String? ?? 'Ctrl+Shift+P',
        copyAfterCapture: j['copyAfterCapture'] as bool? ?? true,
        showQuickPreview: j['showQuickPreview'] as bool? ?? true,
        annotationModelId: j['annotationModelId'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'captureHotkey': captureHotkey,
        'pinHotkey': pinHotkey,
        'copyAfterCapture': copyAfterCapture,
        'showQuickPreview': showQuickPreview,
        'annotationModelId': annotationModelId,
      };
}

/// 万物互联设置——连接到 tietiezhi 服务端 hub，与其它设备互发消息。
class InterconnectSettings {
  String serverBaseUrl; // 例如 http://127.0.0.1:18178 或 https://your-server
  String deviceName; // 在设备列表里显示的名字
  bool autoConnect; // 启动即自动连接

  InterconnectSettings({
    this.serverBaseUrl = '',
    this.deviceName = '',
    this.autoConnect = false,
  });

  factory InterconnectSettings.fromJson(Map<String, dynamic> j) =>
      InterconnectSettings(
        serverBaseUrl: j['serverBaseUrl'] as String? ?? '',
        deviceName: j['deviceName'] as String? ?? '',
        autoConnect: j['autoConnect'] as bool? ?? false,
      );

  Map<String, dynamic> toJson() => {
        'serverBaseUrl': serverBaseUrl,
        'deviceName': deviceName,
        'autoConnect': autoConnect,
      };
}

/// The whole persisted config document.
class Settings {
  List<ApiProvider> providers;
  List<ModelConfig> models;
  String? activeChatModelId;
  DictationSettings dictation;
  CaptureSettings capture;
  InterconnectSettings interconnect;

  Settings({
    List<ApiProvider>? providers,
    List<ModelConfig>? models,
    this.activeChatModelId,
    DictationSettings? dictation,
    CaptureSettings? capture,
    InterconnectSettings? interconnect,
  })  : providers = providers ?? [],
        models = models ?? [],
        dictation = dictation ?? DictationSettings(),
        capture = capture ?? CaptureSettings(),
        interconnect = interconnect ?? InterconnectSettings();

  factory Settings.fromJson(Map<String, dynamic> j) => Settings(
        providers: (j['providers'] as List? ?? [])
            .map((e) => ApiProvider.fromJson(e as Map<String, dynamic>))
            .toList(),
        models: (j['models'] as List? ?? [])
            .map((e) => ModelConfig.fromJson(e as Map<String, dynamic>))
            .toList(),
        activeChatModelId: j['activeChatModelId'] as String?,
        dictation: j['dictation'] is Map
            ? DictationSettings.fromJson(j['dictation'] as Map<String, dynamic>)
            : null,
        capture: j['capture'] is Map
            ? CaptureSettings.fromJson(j['capture'] as Map<String, dynamic>)
            : null,
        interconnect: j['interconnect'] is Map
            ? InterconnectSettings.fromJson(j['interconnect'] as Map<String, dynamic>)
            : null,
      );

  Map<String, dynamic> toJson() => {
        'providers': providers.map((p) => p.toJson()).toList(),
        'models': models.map((m) => m.toJson()).toList(),
        'activeChatModelId': activeChatModelId,
        'dictation': dictation.toJson(),
        'capture': capture.toJson(),
        'interconnect': interconnect.toJson(),
      };

  List<ModelConfig> get chatModels =>
      models.where((m) => m.capability == Capability.chat).toList();
  List<ModelConfig> get asrModels =>
      models.where((m) => m.capability == Capability.asr).toList();

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
