import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:record/record.dart';

/// Captures microphone audio as raw 16-bit mono PCM at [sampleRate], accumulating
/// samples in memory (no file IO → works on every platform incl. web) and pushing
/// a normalized 0..1 level for the pill meter. Mirrors the macOS AudioCapture:
/// downmixed mono, fixed rate, RMS level.
class DictationRecorder {
  DictationRecorder({this.sampleRate = 16000});
  final int sampleRate;

  final AudioRecorder _rec = AudioRecorder();
  final BytesBuilder _pcm = BytesBuilder(copy: false);
  StreamSubscription<Uint8List>? _sub;

  /// Pushed on each audio chunk: RMS level in 0..1 for the meter.
  void Function(double level)? onLevel;

  bool get isRecording => _sub != null;

  Future<bool> hasPermission() => _rec.hasPermission();

  /// Begin capturing. Throws if permission is denied or the mic can't start.
  Future<void> start() async {
    if (_sub != null) return;
    if (!await _rec.hasPermission()) {
      throw StateError('麦克风权限被拒绝');
    }
    _pcm.clear();
    final stream = await _rec.startStream(RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: sampleRate,
      numChannels: 1,
    ));
    _sub = stream.listen((chunk) {
      _pcm.add(chunk);
      onLevel?.call(_levelOf(chunk));
    });
  }

  /// Stop capturing and return the accumulated PCM16 mono bytes.
  Future<Uint8List> stop() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _rec.stop();
    } catch (_) {
      // stream mode may already be stopped; ignore
    }
    return _pcm.toBytes();
  }

  /// Abort without keeping audio.
  Future<void> cancel() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _rec.stop();
    } catch (_) {}
    _pcm.clear();
  }

  Future<void> dispose() async {
    await _sub?.cancel();
    await _rec.dispose();
  }

  /// RMS of a PCM16 little-endian chunk, mapped to a 0..1 meter value.
  static double _levelOf(Uint8List chunk) {
    if (chunk.length < 2) return 0;
    final view = ByteData.sublistView(chunk);
    final n = chunk.length ~/ 2;
    var sumSq = 0.0;
    for (var i = 0; i < n; i++) {
      final s = view.getInt16(i * 2, Endian.little) / 32768.0;
      sumSq += s * s;
    }
    final rms = sqrt(sumSq / n);
    // Light compression so quiet speech still moves the meter.
    return (rms * 3.5).clamp(0.0, 1.0);
  }
}
