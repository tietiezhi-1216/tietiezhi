import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'models.dart';

class TranscribeException implements Exception {
  final String message;
  TranscribeException(this.message);
  @override
  String toString() => message;
}

/// Speech → text. Ported from the macOS `Transcriber.swift`.
///
/// Primary protocol is OpenAI Whisper-style multipart upload to
/// `POST /audio/transcriptions` (Wire.whisper), returning `{ text }`.
/// Audio comes in as raw little-endian 16-bit mono PCM (from the recorder's
/// stream); [wavFromPcm16] wraps it in a WAV container in pure Dart so the whole
/// path stays platform-agnostic (works on web too — no file IO).
class Transcriber {
  final http.Client _client = http.Client();

  /// Transcribe raw PCM16 mono samples at [sampleRate] Hz.
  /// [language] is a BCP-47-ish hint ("zh"/"en"); empty/"auto" omits it.
  Future<String> transcribe(
    ResolvedModel r,
    Uint8List pcm16, {
    required int sampleRate,
    String? language,
  }) async {
    if (r.provider.apiKey.trim().isEmpty) {
      throw TranscribeException('所选语音识别服务商缺少 API Key。');
    }
    final wav = wavFromPcm16(pcm16, sampleRate);

    final req = http.MultipartRequest('POST', Uri.parse(r.url));
    req.headers.addAll(r.authHeaders());
    req.files.add(http.MultipartFile.fromBytes('file', wav,
        filename: 'audio.wav'));
    req.fields['model'] = r.modelId;
    req.fields['response_format'] = 'json';
    final lang = (language ?? '').trim();
    if (lang.isNotEmpty && lang != 'auto') {
      req.fields['language'] = lang;
    }

    late final http.StreamedResponse resp;
    try {
      resp = await _client.send(req).timeout(const Duration(seconds: 60));
    } catch (e) {
      throw TranscribeException('语音识别请求失败：$e');
    }
    final body = await resp.stream.bytesToString();
    if (resp.statusCode != 200) {
      final snippet = body.length > 400 ? body.substring(0, 400) : body;
      throw TranscribeException('语音识别 ${resp.statusCode}：$snippet');
    }
    try {
      final j = jsonDecode(body) as Map<String, dynamic>;
      return (j['text'] as String?)?.trim() ?? '';
    } catch (_) {
      // Some providers return plain text.
      return body.trim();
    }
  }

  /// Wrap little-endian PCM16 mono samples in a 44-byte WAV header.
  static Uint8List wavFromPcm16(Uint8List pcm, int sampleRate) {
    const headerLen = 44;
    final dataLen = pcm.length;
    final byteRate = sampleRate * 2; // mono * 16-bit
    final out = BytesBuilder();
    final header = ByteData(headerLen);
    void ascii(int offset, String s) {
      for (var i = 0; i < s.length; i++) {
        header.setUint8(offset + i, s.codeUnitAt(i));
      }
    }

    ascii(0, 'RIFF');
    header.setUint32(4, 36 + dataLen, Endian.little);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    header.setUint32(16, 16, Endian.little); // PCM fmt chunk size
    header.setUint16(20, 1, Endian.little); // PCM
    header.setUint16(22, 1, Endian.little); // mono
    header.setUint32(24, sampleRate, Endian.little);
    header.setUint32(28, byteRate, Endian.little);
    header.setUint16(32, 2, Endian.little); // block align
    header.setUint16(34, 16, Endian.little); // bits per sample
    ascii(36, 'data');
    header.setUint32(40, dataLen, Endian.little);
    out.add(header.buffer.asUint8List());
    out.add(pcm);
    return out.toBytes();
  }
}
