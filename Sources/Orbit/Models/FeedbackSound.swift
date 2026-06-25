//  FeedbackSound.swift
//  The customizable feedback-sound system: short audio cues played when the user
//  starts / stops a dictation session.
//
//  There are four moments worth a cue (`FeedbackEvent`): a click-to-start and its
//  click-to-stop, plus a push-to-talk key-down and its release. Each event binds
//  to a `SoundCue` from a user-managed library; a cue's sound comes from one of
//  three sources (`SoundSource`):
//
//   • .system — a built-in macOS alert sound (Tink / Pop / Glass …).
//   • .tone   — a synthesized tone (frequency glide + waveform + duration), so the
//               user can *create* a bespoke cue with no audio file at all.
//   • .file   — an imported audio file copied into the app's sounds directory.
//
//  Persisted inside `Settings`. Decoding is tolerant (each field falls back to a
//  default) so a malformed cue never wipes the rest of the configuration.

import Foundation

// MARK: - Waveform

/// The shape of a synthesized tone. Square / sawtooth are harsher and are
/// rendered a little quieter (see `FeedbackSoundPlayer`).
enum Waveform: String, Codable, Hashable, CaseIterable, Identifiable {
    case sine
    case triangle
    case square
    case sawtooth

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .sine:     return "正弦（柔和）"
        case .triangle: return "三角（清脆）"
        case .square:   return "方波（电子）"
        case .sawtooth: return "锯齿（明亮）"
        }
    }
}

// MARK: - Tone spec

/// A synthesized tone. A linear glide from `startHz` to `endHz` makes "rising"
/// (start) and "falling" (stop) cues feel directional; set them equal for a
/// steady pitch.
struct ToneSpec: Codable, Hashable {
    /// Pitch at the start of the cue, in Hz.
    var startHz: Double
    /// Pitch at the end of the cue, in Hz (== `startHz` for a steady tone).
    var endHz: Double
    /// Total length, in seconds.
    var duration: Double
    var waveform: Waveform

    init(startHz: Double = 660,
         endHz: Double = 660,
         duration: Double = 0.12,
         waveform: Waveform = .sine) {
        self.startHz = startHz
        self.endHz = endHz
        self.duration = duration
        self.waveform = waveform
    }
}

// MARK: - Sound source

/// Where a cue's audio comes from. `Codable` via an explicit `type` discriminator
/// so the on-disk shape is stable and tolerant of partial data.
enum SoundSource: Hashable {
    case silent
    case system(String)   // a macOS named alert sound
    case tone(ToneSpec)   // a synthesized tone
    case file(String)     // a filename under the app's sounds directory

    var symbol: String {
        switch self {
        case .silent: return "speaker.slash"
        case .system: return "waveform"
        case .tone:   return "waveform.path"
        case .file:   return "music.note"
        }
    }

    var kindLabel: String {
        switch self {
        case .silent: return "静音"
        case .system: return "系统音效"
        case .tone:   return "合成音调"
        case .file:   return "导入文件"
        }
    }
}

extension SoundSource: Codable {
    private enum CodingKeys: String, CodingKey { case type, system, tone, file }
    private enum Kind: String, Codable { case silent, system, tone, file }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? c.decode(Kind.self, forKey: .type)) ?? .silent
        switch kind {
        case .silent:
            self = .silent
        case .system:
            self = .system((try? c.decode(String.self, forKey: .system)) ?? "Tink")
        case .tone:
            self = .tone((try? c.decode(ToneSpec.self, forKey: .tone)) ?? ToneSpec())
        case .file:
            self = .file((try? c.decode(String.self, forKey: .file)) ?? "")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .silent:
            try c.encode(Kind.silent, forKey: .type)
        case .system(let name):
            try c.encode(Kind.system, forKey: .type)
            try c.encode(name, forKey: .system)
        case .tone(let spec):
            try c.encode(Kind.tone, forKey: .type)
            try c.encode(spec, forKey: .tone)
        case .file(let name):
            try c.encode(Kind.file, forKey: .type)
            try c.encode(name, forKey: .file)
        }
    }
}

// MARK: - Sound cue (a library entry)

/// One named, reusable sound the user can bind to events. `volume` is the cue's
/// own gain (0…1); the player multiplies it by the master volume.
struct SoundCue: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var source: SoundSource
    var volume: Double

    init(id: String = UUID().uuidString,
         name: String,
         source: SoundSource,
         volume: Double = 1) {
        self.id = id
        self.name = name
        self.source = source
        self.volume = volume
    }

    private enum CodingKeys: String, CodingKey { case id, name, source, volume }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "提示音"
        source = (try? c.decode(SoundSource.self, forKey: .source)) ?? .silent
        volume = try c.decodeIfPresent(Double.self, forKey: .volume) ?? 1
    }
}

// MARK: - Feedback event

/// A moment in the dictation gesture worth an audible cue. The four map onto the
/// engine's gesture state machine (see `DictationEngine`).
enum FeedbackEvent: String, Codable, Hashable, CaseIterable, Identifiable {
    case clickStart    // 单击开始一次免手会话
    case clickStop     // 再次单击结束会话
    case holdPress     // 长按按下（按住说话）
    case holdRelease   // 长按松手结束

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .clickStart:   return "单击 · 开始"
        case .clickStop:    return "单击 · 结束"
        case .holdPress:    return "长按 · 按下"
        case .holdRelease:  return "长按 · 松手"
        }
    }

    var summary: String {
        switch self {
        case .clickStart:   return "点一下开始录音时"
        case .clickStop:    return "再点一下结束录音时"
        case .holdPress:    return "按住进入「按住说话」时"
        case .holdRelease:  return "松开按键结束时"
        }
    }

    var symbol: String {
        switch self {
        case .clickStart:   return "play.circle"
        case .clickStop:    return "stop.circle"
        case .holdPress:    return "hand.tap"
        case .holdRelease:  return "hand.raised.slash"
        }
    }
}

// MARK: - Feedback sound settings (persisted)

/// The whole feedback-sound configuration: a master switch + volume, the cue
/// library, and which cue each event is bound to.
struct FeedbackSoundSettings: Codable, Hashable {
    var enabled: Bool
    /// Master gain applied on top of each cue's own volume (0…1).
    var masterVolume: Double
    /// The cue library (seeded defaults + anything the user creates).
    var cues: [SoundCue]
    /// `FeedbackEvent.rawValue` → `SoundCue.id`. A missing key means "no sound".
    var bindings: [String: String]

    init(enabled: Bool = true,
         masterVolume: Double = 0.7,
         cues: [SoundCue],
         bindings: [String: String]) {
        self.enabled = enabled
        self.masterVolume = masterVolume
        self.cues = cues
        self.bindings = bindings
    }

    private enum CodingKeys: String, CodingKey { case enabled, masterVolume, cues, bindings }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = FeedbackSoundSettings.defaults
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? d.enabled
        masterVolume = try c.decodeIfPresent(Double.self, forKey: .masterVolume) ?? d.masterVolume
        cues = (try? c.decode([SoundCue].self, forKey: .cues)) ?? d.cues
        bindings = (try? c.decode([String: String].self, forKey: .bindings)) ?? d.bindings
    }

    /// The cue currently bound to an event, if any.
    func cue(for event: FeedbackEvent) -> SoundCue? {
        guard let id = bindings[event.rawValue] else { return nil }
        return cues.first { $0.id == id }
    }

    // MARK: Seed

    static var defaults: FeedbackSoundSettings {
        let start = SoundCue(id: "orbit.start", name: "开始（上行音）",
                             source: .tone(ToneSpec(startHz: 587, endHz: 880, duration: 0.13, waveform: .sine)),
                             volume: 0.9)
        let stop = SoundCue(id: "orbit.stop", name: "结束（下行音）",
                            source: .tone(ToneSpec(startHz: 880, endHz: 494, duration: 0.16, waveform: .sine)),
                            volume: 0.9)
        let press = SoundCue(id: "orbit.press", name: "按下（轻点）",
                             source: .tone(ToneSpec(startHz: 740, endHz: 740, duration: 0.05, waveform: .triangle)),
                             volume: 0.8)
        let release = SoundCue(id: "orbit.release", name: "松手（短促）",
                               source: .tone(ToneSpec(startHz: 620, endHz: 620, duration: 0.07, waveform: .sine)),
                               volume: 0.8)
        let tink = SoundCue(id: "orbit.system.tink", name: "Tink（系统）", source: .system("Tink"))
        let pop = SoundCue(id: "orbit.system.pop", name: "Pop（系统）", source: .system("Pop"))

        return FeedbackSoundSettings(
            enabled: true,
            masterVolume: 0.7,
            cues: [start, stop, press, release, tink, pop],
            bindings: [
                FeedbackEvent.clickStart.rawValue: start.id,
                FeedbackEvent.clickStop.rawValue: stop.id,
                FeedbackEvent.holdPress.rawValue: press.id,
                FeedbackEvent.holdRelease.rawValue: release.id,
            ]
        )
    }

    /// macOS named alert sounds available via `NSSound(named:)`.
    static let systemSoundNames = [
        "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
        "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
    ]
}
