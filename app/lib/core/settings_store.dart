import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'models.dart';

/// Persists [Settings] as a single JSON string via shared_preferences — one code
/// path for every platform (Windows/macOS/Linux/Android/iOS/Web), no dart:io. A
/// ChangeNotifier so the UI rebuilds after edits. Tolerant load (a corrupt/missing
/// value yields a sensible seed, never a crash).
class SettingsStore extends ChangeNotifier {
  static const _key = 'orbit.config.v1';

  Settings settings = Settings();
  SharedPreferences? _prefs;

  Future<void> load() async {
    try {
      _prefs = await SharedPreferences.getInstance();
      final raw = _prefs!.getString(_key);
      if (raw != null && raw.isNotEmpty) {
        settings = Settings.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      } else {
        settings = Settings.seed();
        await _write();
      }
    } catch (_) {
      settings = Settings.seed();
    }
    notifyListeners();
  }

  Future<void> save() async {
    await _write();
    notifyListeners();
  }

  Future<void> _write() async {
    try {
      _prefs ??= await SharedPreferences.getInstance();
      await _prefs!.setString(_key, jsonEncode(settings.toJson()));
    } catch (_) {
      // Best-effort; a failed write shouldn't crash the UI.
    }
  }

  void addProvider() {
    final p = ApiProvider(name: '新厂商', baseUrl: 'https://', auth: AuthScheme.bearer);
    settings.providers.add(p);
    final m = ModelConfig(providerId: p.id, displayName: '新模型');
    settings.models.add(m);
    settings.activeChatModelId = m.id;
    notifyListeners();
  }

  ModelConfig addModel(String? providerId) {
    final pid = providerId ??
        (settings.providers.isNotEmpty ? settings.providers.first.id : '');
    final m = ModelConfig(providerId: pid, displayName: '新模型');
    settings.models.add(m);
    settings.activeChatModelId = m.id;
    notifyListeners();
    return m;
  }
}
