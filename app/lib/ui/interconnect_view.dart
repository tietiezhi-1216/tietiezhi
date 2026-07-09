import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/interconnect.dart';
import '../core/settings_store.dart';
import 'theme.dart';

/// 「万物互联」页：连接 tietiezhi 服务端 hub，查看在线设备并互发消息。
class InterconnectView extends StatefulWidget {
  const InterconnectView({super.key});

  @override
  State<InterconnectView> createState() => _InterconnectViewState();
}

class _InterconnectViewState extends State<InterconnectView> {
  final _msgCtrl = TextEditingController();
  String? _targetId; // null = 广播

  static String get _platformLabel {
    if (kIsWeb) return 'web';
    return defaultTargetPlatform.name; // macOS/android/...
  }

  @override
  void dispose() {
    _msgCtrl.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final store = context.read<SettingsStore>();
    final client = context.read<InterconnectClient>();
    final ic = store.settings.interconnect;
    final name = ic.deviceName.trim().isEmpty
        ? '$_platformLabel-设备'
        : ic.deviceName.trim();
    await client.connect(
      baseUrl: ic.serverBaseUrl,
      deviceName: name,
      platform: _platformLabel,
    );
  }

  void _send() {
    final client = context.read<InterconnectClient>();
    final text = _msgCtrl.text.trim();
    if (text.isEmpty) return;
    client.send(to: _targetId, payload: {'text': text});
    _msgCtrl.clear();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final store = context.watch<SettingsStore>();
    final client = context.watch<InterconnectClient>();
    final ic = store.settings.interconnect;

    return Container(
      color: TietiezhiColors.bg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(client),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
            child: _connectionBar(context, store, ic, client),
          ),
          const Divider(height: 1, color: TietiezhiColors.border),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(width: 240, child: _deviceList(client)),
                const VerticalDivider(width: 1, color: TietiezhiColors.border),
                Expanded(child: _conversation(client)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _header(InterconnectClient client) {
    final (dotColor, label) = switch (client.state) {
      LinkState.connected => (const Color(0xFF22C55E), '已连接'),
      LinkState.connecting => (const Color(0xFFF59E0B), '连接中…'),
      LinkState.disconnected => (TietiezhiColors.textDim, '未连接'),
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
      child: Row(
        children: [
          const Text('🐙  万物互联',
              style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w700,
                  color: TietiezhiColors.text)),
          const SizedBox(width: 12),
          Container(width: 8, height: 8, decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle)),
          const SizedBox(width: 6),
          Text(label, style: TextStyle(fontSize: 12, color: TietiezhiColors.textDim)),
          if (client.myId != null) ...[
            const SizedBox(width: 12),
            Text('本机 ID: ${client.myId!.length > 8 ? client.myId!.substring(0, 8) : client.myId}',
                style: TextStyle(fontSize: 11, color: TietiezhiColors.textDim)),
          ],
        ],
      ),
    );
  }

  Widget _connectionBar(BuildContext context, SettingsStore store,
      dynamic ic, InterconnectClient client) {
    return Row(
      children: [
        Expanded(
          flex: 3,
          child: TextFormField(
            initialValue: ic.serverBaseUrl,
            decoration: const InputDecoration(
              labelText: '服务端地址',
              hintText: 'http://127.0.0.1:18178',
              isDense: true,
            ),
            onChanged: (v) => ic.serverBaseUrl = v,
            onFieldSubmitted: (_) => store.save(),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          flex: 2,
          child: TextFormField(
            initialValue: ic.deviceName,
            decoration: const InputDecoration(
              labelText: '设备名',
              hintText: '我的 Mac',
              isDense: true,
            ),
            onChanged: (v) => ic.deviceName = v,
            onFieldSubmitted: (_) => store.save(),
          ),
        ),
        const SizedBox(width: 10),
        client.isConnected || client.state == LinkState.connecting
            ? OutlinedButton(
                onPressed: () => client.disconnect(),
                child: const Text('断开'),
              )
            : FilledButton(
                onPressed: () async {
                  await store.save();
                  await _connect();
                },
                child: const Text('连接'),
              ),
      ],
    );
  }

  Widget _deviceList(InterconnectClient client) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
          child: Text('在线设备 · ${client.devices.length}',
              style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: TietiezhiColors.textDim)),
        ),
        Expanded(
          child: client.devices.isEmpty
              ? Center(
                  child: Text('暂无设备',
                      style: TextStyle(color: TietiezhiColors.textDim, fontSize: 12)))
              : ListView(
                  children: [
                    _deviceTile(
                        id: null,
                        title: '📢 广播（所有设备）',
                        subtitle: '发给除自己外的全部设备',
                        selected: _targetId == null),
                    ...client.devices.map((d) {
                      final isSelf = d.id == client.myId;
                      return _deviceTile(
                        id: d.id,
                        title: '${_platformEmoji(d.platform)} ${d.name}${isSelf ? '（本机）' : ''}',
                        subtitle: d.id.length > 8 ? d.id.substring(0, 8) : d.id,
                        selected: _targetId == d.id,
                        disabled: isSelf,
                      );
                    }),
                  ],
                ),
        ),
      ],
    );
  }

  Widget _deviceTile({
    required String? id,
    required String title,
    required String subtitle,
    required bool selected,
    bool disabled = false,
  }) {
    return Material(
      color: selected ? TietiezhiColors.panelAlt : Colors.transparent,
      child: InkWell(
        onTap: disabled ? null : () => setState(() => _targetId = id),
        child: Opacity(
          opacity: disabled ? 0.5 : 1,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(
                        color: TietiezhiColors.text, fontSize: 13),
                    overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text(subtitle,
                    style: TextStyle(
                        color: TietiezhiColors.textDim, fontSize: 11)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _conversation(InterconnectClient client) {
    return Column(
      children: [
        Expanded(
          child: client.inbox.isEmpty
              ? Center(
                  child: Text('还没有收到消息',
                      style: TextStyle(color: TietiezhiColors.textDim)))
              : ListView.builder(
                  padding: const EdgeInsets.all(16),
                  itemCount: client.inbox.length,
                  itemBuilder: (_, i) {
                    final m = client.inbox[client.inbox.length - 1 - i];
                    final text = m.payload['text']?.toString() ?? m.payload.toString();
                    final fromShort = m.from.length > 8 ? m.from.substring(0, 8) : m.from;
                    return Container(
                      margin: const EdgeInsets.only(bottom: 10),
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: TietiezhiColors.panelAlt,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('来自 $fromShort',
                              style: TextStyle(
                                  fontSize: 11, color: TietiezhiColors.textDim)),
                          const SizedBox(height: 4),
                          Text(text,
                              style: const TextStyle(
                                  fontSize: 14, color: TietiezhiColors.text)),
                        ],
                      ),
                    );
                  },
                ),
        ),
        const Divider(height: 1, color: TietiezhiColors.border),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _msgCtrl,
                  enabled: client.isConnected,
                  decoration: InputDecoration(
                    hintText: client.isConnected
                        ? (_targetId == null ? '广播一条消息…' : '发给选中设备…')
                        : '先连接服务端',
                    isDense: true,
                  ),
                  onSubmitted: (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: client.isConnected ? _send : null,
                child: const Text('发送'),
              ),
            ],
          ),
        ),
      ],
    );
  }

  static String _platformEmoji(String platform) {
    final p = platform.toLowerCase();
    if (p.contains('mac') || p.contains('ios')) return '🍎';
    if (p.contains('android')) return '🤖';
    if (p.contains('windows')) return '🪟';
    if (p.contains('linux')) return '🐧';
    if (p.contains('web')) return '🌐';
    return '📟';
  }
}
