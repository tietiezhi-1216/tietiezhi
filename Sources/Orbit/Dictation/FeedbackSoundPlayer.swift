//  FeedbackSoundPlayer.swift
//  Plays a `SoundCue` — used both for live dictation cues (driven by
//  `DictationEngine`) and for previewing/debugging in the settings editor.
//
//  Three paths: macOS named alert sounds go through `NSSound`; imported files and
//  synthesized tones go through `AVAudioPlayer`. Tones are rendered on the fly to
//  an in-memory 16-bit PCM WAV — no temp files, no audio-graph setup — which is
//  both reliable and cheap for the few-thousand-sample clips these cues are.
//
//  Players are retained while they sound (so they aren't deallocated mid-play)
//  and finished ones are pruned on the next play; cues are short, so this stays a
//  tiny list.

import AVFoundation
import AppKit

@MainActor
final class FeedbackSoundPlayer {
    private var players: [AVAudioPlayer] = []
    private var sounds: [NSSound] = []

    /// Play a cue. `masterVolume` is folded in on top of the cue's own volume.
    func play(_ cue: SoundCue, masterVolume: Double = 1) {
        // Drop anything that finished since last time.
        players.removeAll { !$0.isPlaying }
        sounds.removeAll { !$0.isPlaying }

        let volume = Float(max(0, min(1, cue.volume * masterVolume)))

        switch cue.source {
        case .silent:
            return

        case .system(let name):
            guard let base = NSSound(named: NSSound.Name(name)) else { return }
            // NSSound(named:) hands back a shared, cached instance; copy it so a
            // rapid re-trigger overlaps instead of cutting the previous play off.
            let sound = (base.copy() as? NSSound) ?? base
            sound.volume = volume
            sounds.append(sound)
            sound.play()

        case .tone(let spec):
            guard let data = FeedbackSoundPlayer.renderWAV(spec) else { return }
            play(data: data, volume: volume)

        case .file(let filename):
            let url = FeedbackSoundPlayer.soundsDirectory().appendingPathComponent(filename)
            guard let player = try? AVAudioPlayer(contentsOf: url) else { return }
            play(player: player, volume: volume)
        }
    }

    private func play(data: Data, volume: Float) {
        guard let player = try? AVAudioPlayer(data: data) else { return }
        play(player: player, volume: volume)
    }

    private func play(player: AVAudioPlayer, volume: Float) {
        player.volume = volume
        player.prepareToPlay()
        players.append(player)
        player.play()
    }

    // MARK: - Tone synthesis

    /// Render a tone to a mono 16-bit PCM WAV `Data` at 44.1 kHz. Phase is
    /// accumulated incrementally so the frequency glide stays continuous, and a
    /// short attack/release envelope avoids the clicks a raw on/off would make.
    nonisolated static func renderWAV(_ spec: ToneSpec) -> Data? {
        let sampleRate = 44_100.0
        let total = max(1, Int((max(0.01, spec.duration)) * sampleRate))
        let startHz = max(20, spec.startHz)
        let endHz = max(20, spec.endHz)

        // Harsher waveforms are perceptually louder — trim their gain.
        let waveGain: Double
        switch spec.waveform {
        case .sine:     waveGain = 1.0
        case .triangle: waveGain = 0.85
        case .square:   waveGain = 0.45
        case .sawtooth: waveGain = 0.55
        }
        let amplitude = 0.6 * waveGain

        let attack = min(Double(total) * 0.25, 0.004 * sampleRate)   // ~4ms
        let release = min(Double(total) * 0.5, 0.03 * sampleRate)    // ~30ms

        var samples = [Int16](repeating: 0, count: total)
        var phase = 0.0   // cycle fraction in [0, 1)
        let denom = Double(max(1, total - 1))

        for i in 0..<total {
            let progress = Double(i) / denom
            let hz = startHz + (endHz - startHz) * progress
            let raw = FeedbackSoundPlayer.waveform(spec.waveform, phase: phase)
            phase += hz / sampleRate
            if phase >= 1 { phase -= floor(phase) }

            var env = 1.0
            if Double(i) < attack { env = Double(i) / attack }
            let fromEnd = Double(total - 1 - i)
            if fromEnd < release { env = min(env, fromEnd / release) }

            let value = max(-1, min(1, raw * env * amplitude))
            samples[i] = Int16(value * 32_767)
        }

        return wavData(samples: samples, sampleRate: Int(sampleRate))
    }

    /// One waveform period mapped from a cycle fraction `phase` in [0, 1).
    private nonisolated static func waveform(_ shape: Waveform, phase: Double) -> Double {
        switch shape {
        case .sine:     return sin(2 * .pi * phase)
        case .square:   return phase < 0.5 ? 1 : -1
        case .triangle: return 4 * abs(phase - 0.5) - 1
        case .sawtooth: return 2 * phase - 1
        }
    }

    /// Wrap little-endian 16-bit mono PCM samples in a canonical 44-byte WAV
    /// header. (Int16 is host-endian, i.e. little-endian on Apple hardware.)
    private nonisolated static func wavData(samples: [Int16], sampleRate: Int) -> Data {
        let channels = 1
        let bitsPerSample = 16
        let blockAlign = channels * bitsPerSample / 8
        let byteRate = sampleRate * blockAlign
        let dataSize = samples.count * blockAlign

        var data = Data()
        func ascii(_ s: String) { data.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { data.append(contentsOf: $0) } }

        ascii("RIFF"); u32(UInt32(36 + dataSize)); ascii("WAVE")
        ascii("fmt "); u32(16); u16(1); u16(UInt16(channels))
        u32(UInt32(sampleRate)); u32(UInt32(byteRate)); u16(UInt16(blockAlign)); u16(UInt16(bitsPerSample))
        ascii("data"); u32(UInt32(dataSize))
        samples.withUnsafeBufferPointer { data.append(contentsOf: UnsafeRawBufferPointer($0)) }
        return data
    }

    // MARK: - Imported files

    /// `~/Library/Application Support/com.orbit.app/sounds/`
    nonisolated static func soundsDirectory() -> URL {
        let dir = SettingsStore.configDirectory().appendingPathComponent("sounds", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Copy a user-chosen audio file into the sounds directory under a fresh
    /// name, returning the stored filename (to put in a `.file` cue).
    nonisolated static func importFile(from url: URL) -> String? {
        let ext = url.pathExtension.isEmpty ? "caf" : url.pathExtension
        let filename = UUID().uuidString + "." + ext
        let dest = soundsDirectory().appendingPathComponent(filename)
        do {
            try FileManager.default.copyItem(at: url, to: dest)
            return filename
        } catch {
            NSLog("[feedback-sound] 导入失败：\(error.localizedDescription)")
            return nil
        }
    }

    /// Remove an imported file (called when its last referencing cue is deleted).
    nonisolated static func deleteFile(filename: String) {
        guard !filename.isEmpty else { return }
        try? FileManager.default.removeItem(at: soundsDirectory().appendingPathComponent(filename))
    }
}
