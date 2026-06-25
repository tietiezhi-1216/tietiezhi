//  AudioCapture.swift
//  Microphone capture via AVAudioEngine. Taps the default input, downmixes to
//  mono, linearly resamples to a target rate, and hands `Int16` PCM frames to a
//  callback (on AVAudioEngine's tap thread). Mirrors the old Rust cpal pipeline.

import AVFoundation

final class AudioCapture {
    private let engine = AVAudioEngine()
    private let targetRate: Double
    private let onFrame: ([Int16]) -> Void
    private var srcRate: Double = 48_000
    private let lock = NSLock()
    private var stopped = false

    /// - Parameters:
    ///   - targetRate: desired output sample rate (e.g. 16_000).
    ///   - onFrame: called with each resampled mono Int16 frame, off the main thread.
    init(targetRate: Int, onFrame: @escaping ([Int16]) -> Void) {
        self.targetRate = Double(targetRate)
        self.onFrame = onFrame
    }

    func start() throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        srcRate = format.sampleRate
        guard srcRate > 0, format.channelCount > 0 else {
            throw OrbitError("找不到可用的麦克风输入。")
        }
        let target = targetRate
        let cb = onFrame
        input.installTap(onBus: 0, bufferSize: 2_048, format: format) { buffer, _ in
            let frame = AudioCapture.process(buffer, srcRate: format.sampleRate, targetRate: target)
            if !frame.isEmpty { cb(frame) }
        }
        engine.prepare()
        // `start()` may run off the main thread (so the UI doesn't stall on the
        // first record). Guard against a `stop()` that raced ahead of us.
        if isStopped { input.removeTap(onBus: 0); return }
        try engine.start()
        if isStopped { engine.stop(); input.removeTap(onBus: 0) }
    }

    func stop() {
        lock.lock(); stopped = true; lock.unlock()
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
    }

    private var isStopped: Bool {
        lock.lock(); defer { lock.unlock() }; return stopped
    }

    // MARK: - DSP

    private static func process(_ buffer: AVAudioPCMBuffer, srcRate: Double, targetRate: Double) -> [Int16] {
        guard let channelData = buffer.floatChannelData else { return [] }
        let channels = Int(buffer.format.channelCount)
        let n = Int(buffer.frameLength)
        if channels == 0 || n == 0 { return [] }

        // Downmix to mono.
        var mono = [Float](repeating: 0, count: n)
        for i in 0..<n {
            var acc: Float = 0
            for c in 0..<channels { acc += channelData[c][i] }
            mono[i] = acc / Float(channels)
        }

        if srcRate == targetRate {
            return mono.map(toI16)
        }

        // Linear resample mono → targetRate.
        let ratio = targetRate / srcRate
        let outLen = Int(Double(n) * ratio)
        var out = [Int16]()
        out.reserveCapacity(outLen)
        for i in 0..<outLen {
            let pos = Double(i) / ratio
            let idx = Int(pos)
            let frac = Float(pos - Double(idx))
            let a = idx < n ? mono[idx] : 0
            let b = (idx + 1) < n ? mono[idx + 1] : a
            out.append(toI16(a + (b - a) * frac))
        }
        return out
    }

    private static func toI16(_ v: Float) -> Int16 {
        let clamped = max(-1.0, min(1.0, v))
        return Int16(clamped * 32_767)
    }

    /// Perceptual mic loudness mapped to 0…1 for the recording meter. A dB scale
    /// (not raw RMS × gain, which pinned everything to the top) so quiet speech
    /// reads low and loud speech approaches full with real spread in between.
    static func level(_ frame: [Int16]) -> Float {
        if frame.isEmpty { return 0 }
        var sum = 0.0
        for s in frame {
            let f = Double(s) / 32_768.0
            sum += f * f
        }
        let rms = (sum / Double(frame.count)).squareRoot()
        guard rms > 0 else { return 0 }
        let db = 20 * log10(rms)          // ≈ -∞ (silence) … 0 dBFS (full scale)
        // Gate the noise floor hard so an idle room reads exactly 0 (flat), then map
        // a speech window to 0…1 and expand the low end (^1.4) so light ambient
        // stays near the floor and only real speech climbs. Tunable: lower `gateDB`
        // = more sensitive; raise it if a noisy room still lifts the meter.
        let gateDB = -38.0
        let ceilDB = -10.0
        guard db > gateDB else { return 0 }
        let norm = min(1, (db - gateDB) / (ceilDB - gateDB))
        return Float(pow(norm, 1.4))
    }
}
