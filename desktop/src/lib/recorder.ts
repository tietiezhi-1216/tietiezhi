//! Microphone capture in the WebView: taps the default input via Web Audio,
//! accumulates mono PCM, and encodes it as a 16 kHz 16-bit WAV (Base64) for the
//! Rust ASR command.

const TARGET_RATE = 16000;

export interface Recorder {
  /** Stop capture and return the recording as a Base64 WAV. */
  stop: () => string;
  /** Discard the recording and release the mic. */
  cancel: () => void;
}

/** Start recording; `onLevel` receives a 0…1 loudness value per audio buffer. */
export async function startRecorder(onLevel: (level: number) => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // A muted sink keeps the processor pulling audio without echoing to speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    onLevel(computeLevel(input));
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);
  const srcRate = ctx.sampleRate;

  const cleanup = () => {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return {
    stop: () => {
      cleanup();
      const pcm = mergeAndResample(chunks, srcRate);
      return encodeWavBase64(pcm, TARGET_RATE);
    },
    cancel: () => {
      cleanup();
      chunks.length = 0;
    },
  };
}

/** Perceptual loudness 0…1 (dB scale, noise-gated) for the level meter. */
function computeLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  const gate = -38;
  const ceil = -10;
  if (db <= gate) return 0;
  return Math.pow(Math.min(1, (db - gate) / (ceil - gate)), 1.4);
}

/** Concatenate captured Float32 chunks and linearly resample to 16 kHz. */
function mergeAndResample(chunks: Float32Array[], srcRate: number): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  if (srcRate === TARGET_RATE) return merged;

  const ratio = TARGET_RATE / srcRate;
  const outLen = Math.floor(merged.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = merged[idx] ?? 0;
    const b = merged[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Encode mono Float32 PCM as a 16-bit little-endian WAV, Base64-encoded. */
function encodeWavBase64(pcm: Float32Array, rate: number): string {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, clamped * 0x7fff, true);
    offset += 2;
  }

  return bytesToBase64(new Uint8Array(buffer));
}

/** Base64-encode bytes, chunked so large recordings don't blow the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
