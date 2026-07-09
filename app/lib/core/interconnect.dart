import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as ws_status;

/// 一台在线设备（来自 hub 的 presence 列表）。
class RemoteDevice {
  final String id;
  final String name;
  final String platform;
  const RemoteDevice({required this.id, required this.name, required this.platform});

  factory RemoteDevice.fromJson(Map<String, dynamic> j) => RemoteDevice(
        id: j['id'] as String? ?? '',
        name: j['name'] as String? ?? '',
        platform: j['platform'] as String? ?? '',
      );
}

/// 收到的一条互联消息。
class InterconnectMessage {
  final String from;
  final Map<String, dynamic> payload;
  final DateTime at;
  const InterconnectMessage({required this.from, required this.payload, required this.at});
}

enum LinkState { disconnected, connecting, connected }

/// InterconnectClient 是 Go 万物互联 hub 的 Flutter 对端：连接、注册身份、
/// 维护在线设备列表、收发消息。作为 ChangeNotifier 驱动「互联」页 UI。
///
/// 与服务端约定的信封：{type, from, to, name, platform, payload}，
/// type ∈ hello|welcome|presence|message|ping|pong；to 空表示广播。
class InterconnectClient extends ChangeNotifier {
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _reconnectTimer;

  LinkState state = LinkState.disconnected;
  String? myId; // hub 分配 / 复用的 deviceID
  String? lastError;
  List<RemoteDevice> devices = [];
  final List<InterconnectMessage> inbox = [];

  String _baseUrl = '';
  String _deviceName = '';
  String? _fixedId; // 复用固定 id 便于重连保持身份
  bool _manualDisconnect = false;

  bool get isConnected => state == LinkState.connected;

  /// 把 http(s):// 基址转成 ws(s):// 的 /v1/connect 端点。
  static String? _wsEndpoint(String baseUrl, {String? id}) {
    final trimmed = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
    if (trimmed.isEmpty) return null;
    var url = trimmed;
    if (url.startsWith('https://')) {
      url = 'wss://${url.substring(8)}';
    } else if (url.startsWith('http://')) {
      url = 'ws://${url.substring(7)}';
    } else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://$url';
    }
    url = '$url/v1/connect';
    if (id != null && id.isNotEmpty) {
      url = '$url?id=${Uri.encodeQueryComponent(id)}';
    }
    return url;
  }

  /// 连接到 hub 并以 deviceName 注册。platform 用于设备列表展示。
  Future<void> connect({
    required String baseUrl,
    required String deviceName,
    required String platform,
    String? fixedId,
  }) async {
    _manualDisconnect = false;
    _baseUrl = baseUrl;
    _deviceName = deviceName;
    _fixedId = fixedId ?? _fixedId;
    _platform = platform;
    await _open();
  }

  String _platform = '';

  Future<void> _open() async {
    _reconnectTimer?.cancel();
    final endpoint = _wsEndpoint(_baseUrl, id: _fixedId);
    if (endpoint == null) {
      lastError = '服务端地址为空';
      state = LinkState.disconnected;
      notifyListeners();
      return;
    }

    state = LinkState.connecting;
    lastError = null;
    notifyListeners();

    try {
      final channel = WebSocketChannel.connect(Uri.parse(endpoint));
      _channel = channel;
      // 首帧 hello 注册身份
      channel.sink.add(jsonEncode({
        'type': 'hello',
        'name': _deviceName,
        'platform': _platform,
      }));
      _sub = channel.stream.listen(
        _onData,
        onError: _onError,
        onDone: _onDone,
        cancelOnError: true,
      );
    } catch (e) {
      _onError(e);
    }
  }

  void _onData(dynamic raw) {
    Map<String, dynamic> env;
    try {
      env = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (env['type']) {
      case 'welcome':
        myId = env['from'] as String?;
        _fixedId = myId; // 之后重连复用同一 id
        state = LinkState.connected;
        lastError = null;
        notifyListeners();
        break;
      case 'presence':
        final list = (env['devices'] as List? ?? [])
            .map((e) => RemoteDevice.fromJson(e as Map<String, dynamic>))
            .toList();
        devices = list;
        notifyListeners();
        break;
      case 'message':
        inbox.add(InterconnectMessage(
          from: env['from'] as String? ?? '',
          payload: (env['payload'] as Map?)?.cast<String, dynamic>() ?? {},
          at: DateTime.now(),
        ));
        if (inbox.length > 200) inbox.removeAt(0);
        notifyListeners();
        break;
      case 'pong':
        break;
    }
  }

  void _onError(Object e) {
    lastError = e.toString();
    _teardown();
    _scheduleReconnect();
  }

  void _onDone() {
    _teardown();
    if (!_manualDisconnect) _scheduleReconnect();
  }

  void _teardown() {
    _sub?.cancel();
    _sub = null;
    _channel = null;
    devices = [];
    state = LinkState.disconnected;
    notifyListeners();
  }

  void _scheduleReconnect() {
    if (_manualDisconnect) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 3), _open);
  }

  /// 发送一条消息：to 为空表示广播给所有其它设备。
  void send({String? to, required Map<String, dynamic> payload}) {
    final ch = _channel;
    if (ch == null || state != LinkState.connected) return;
    ch.sink.add(jsonEncode({
      'type': 'message',
      if (to != null && to.isNotEmpty) 'to': to,
      'payload': payload,
    }));
  }

  /// 主动断开，不再自动重连。
  Future<void> disconnect() async {
    _manualDisconnect = true;
    _reconnectTimer?.cancel();
    await _channel?.sink.close(ws_status.normalClosure);
    _teardown();
  }

  @override
  void dispose() {
    _manualDisconnect = true;
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}
