import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/chat_client.dart';
import '../core/models.dart';
import '../core/settings_store.dart';
import '../core/transcriber.dart';
import 'audio_recorder.dart';
import 'text_inserter.dart';

enum DictationPhase { idle, recording, transcribing, polishing, done, error }

/// Drives 录音 → ASR →（可选）LLM 润色 →（可选）投递 as a state machine, mirroring
/// the macOS DictationEngine but simplified for the Flutter client: a single
/// toggle (start/stop) session. As a ChangeNotifier it drives the floating pill.
class DictationController extends ChangeNotifier {
  DictationController(this._store);
  final SettingsStore _store;

  final DictationRecorder _recorder = DictationRecorder(sampleRate: 16000);
  final Transcriber _transcriber = Transcriber();
  final ChatClient _chat = ChatClient();

  DictationPhase phase = DictationPhase.idle;
  double level = 0; // live mic level 0..1
  String resultText = ''; // last transcript (shown in pill on done)
  String statusText = ''; // short status / delivery note
  String? errorText;

  bool get isBusy => phase != DictationPhase.idle;
  bool get isRecording => phase == DictationPhase.recording;

  Settings get _settings => _store.settings;

  ModelConfig? _modelById(String? id) {
    if (id == null) return null;
    for (final m in _settings.models) {
      if (m.id == id) return m;
    }
    return null;
  }

  ResolvedModel? get _asr {
    final d = _settings.dictation;
    final m = _modelById(d.asrModelId) ??
        (_settings.asrModels.isNotEmpty ? _settings.asrModels.first : null);
    return _settings.resolve(m);
  }

  ResolvedModel? get _polishLlm {
    final d = _settings.dictation;
    if (!d.cleanOutput) return null;
    final m = _modelById(d.llmModelId);
    return _settings.resolve(m);
  }

  /// Hotkey / button entry point: start if idle, stop-and-process if recording.
  Future<void> toggle() async {
    if (phase == DictationPhase.recording) {
      await _stopAndProcess();
    } else if (phase == DictationPhase.idle ||
        phase == DictationPhase.done ||
        phase == DictationPhase.error) {
      await _start();
    }
    // transcribing/polishing: ignore re-entry
  }

  Future<void> _start() async {
    if (_asr == null) {
      _fail('未选择语音识别模型，请在「设置 → 听写」里选择一个 Whisper 模型。');
      return;
    }
    try {
      _recorder.onLevel = (l) {
        level = l;
        notifyListeners();
      };
      await _recorder.start();
      errorText = null;
      resultText = '';
      statusText = '';
      phase = DictationPhase.recording;
      notifyListeners();
    } catch (e) {
      _fail('无法开始录音：$e');
    }
  }

  Future<void> _stopAndProcess() async {
    final pcm = await _recorder.stop();
    level = 0;
    final asr = _asr;
    if (asr == null) {
      _fail('识别模型缺失。');
      return;
    }
    if (pcm.isEmpty) {
      phase = DictationPhase.idle;
      notifyListeners();
      return;
    }

    phase = DictationPhase.transcribing;
    notifyListeners();
    String text;
    try {
      text = await _transcriber.transcribe(asr, pcm,
          sampleRate: 16000, language: _settings.dictation.outputLanguage);
    } catch (e) {
      _fail('$e');
      return;
    }
    text = text.trim();
    if (text.isEmpty) {
      _fail('没有识别到内容。');
      return;
    }

    // Optional LLM polish.
    final llm = _polishLlm;
    if (llm != null) {
      phase = DictationPhase.polishing;
      resultText = text;
      notifyListeners();
      try {
        text = (await _polish(llm, text)).trim();
      } catch (_) {
        // Polish is best-effort — fall back to the raw transcript.
      }
    }

    resultText = text;
    statusText = await TextInserter.deliver(text,
        autoInsert: _settings.dictation.autoInsert);
    phase = DictationPhase.done;
    notifyListeners();

    // Auto-clear the pill after a moment.
    Timer(const Duration(seconds: 3), () {
      if (phase == DictationPhase.done) {
        phase = DictationPhase.idle;
        notifyListeners();
      }
    });
  }

  Future<String> _polish(ResolvedModel llm, String raw) async {
    final lang = _settings.dictation.outputLanguage;
    final langHint = switch (lang) {
      'zh' => '用简体中文输出。',
      'en' => 'Output in English.',
      _ => '保持原文语言。',
    };
    final system =
        '你是听写后处理器。把下面的口述转写整理为通顺文本：补全标点、去掉口头语和口吃重复、'
        '不要改变原意、不要新增内容、不要解释。$langHint 只输出整理后的文本本身。';
    final buf = StringBuffer();
    await for (final delta in _chat.stream(llm, [
      ChatMessage('system', system),
      ChatMessage('user', raw),
    ])) {
      buf.write(delta);
    }
    final out = buf.toString().trim();
    return out.isEmpty ? raw : out;
  }

  Future<void> cancel() async {
    await _recorder.cancel();
    level = 0;
    phase = DictationPhase.idle;
    statusText = '';
    notifyListeners();
  }

  void _fail(String message) {
    errorText = message;
    phase = DictationPhase.error;
    level = 0;
    notifyListeners();
    Timer(const Duration(seconds: 4), () {
      if (phase == DictationPhase.error) {
        phase = DictationPhase.idle;
        notifyListeners();
      }
    });
  }

  @override
  void dispose() {
    _recorder.dispose();
    super.dispose();
  }
}
