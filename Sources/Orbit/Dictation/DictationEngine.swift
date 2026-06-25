//  DictationEngine.swift
//  Ties recording → ASR → (optional) LLM polish → (optional) auto-insert
//  together, driving the on-screen pill, and resolves the two hotkey gestures:
//
//   • 单击切换 (click): a quick press starts a hands-free session; click again to
//                      finish — ASR + LLM polish.
//   • 长按 (hold):      hold and speak, release to finish — ASR only, NO polish.
//
//  Which one it is comes down to the FIRST press: released before the hold
//  threshold → it was a click (toggle session); still held past the threshold →
//  it's push-to-talk. Gesture detection lives here (on the main actor); the
//  HotkeyMonitor only reports raw down/up. Audio capture starts on the first
//  key-down so neither mode clips the opening syllable.
//
//  Recording is serial (one mic), but processing is not: on commit the captured
//  audio is handed to `DictationQueue` and the engine returns to idle immediately,
//  so the next recording can start while previous utterances transcribe / polish
//  in the background. The recording pill only covers the live mic; in-flight jobs
//  and their results live in the result stack (see ResultStackController).

import AppKit

/// Thread-safe accumulator for PCM frames arriving on the audio thread.
private final class FrameSink {
    private let lock = NSLock()
    private var buffer: [Int16] = []

    func append(_ frame: [Int16]) {
        lock.lock(); buffer.append(contentsOf: frame); lock.unlock()
    }
    func drain() -> [Int16] {
        lock.lock(); defer { buffer = []; lock.unlock() }
        return buffer
    }
    func reset() {
        lock.lock(); buffer = []; lock.unlock()
    }
}

@MainActor
final class DictationEngine {
    private let store: SettingsStore
    private let queue: DictationQueue
    /// Live recording state shown as the front card of the unified deck.
    private let recording: RecordingState
    /// Used only for error notices now (the recording capsule moved into the deck).
    private let pill = PillController()
    private let sink = FrameSink()
    /// Plays the start/stop feedback cues bound in settings.
    private let sounds = FeedbackSoundPlayer()
    private var capture: AudioCapture?

    /// A confirmed session whose pill is on screen.
    private var active = false
    /// Audio is being captured (may precede `active` during gesture disambiguation).
    private var capturing = false
    /// Whether the in-flight session should run the LLM polish step. Set by the
    /// gesture: hold → false (push-to-talk), click → true.
    private var polishThisSession = false
    /// The focused app when recording began — fed into the polish prompt so the
    /// model can match tone (email vs chat vs IDE). Captured before Orbit could
    /// come forward.
    private var frontApp: String?

    private let httpRate = 16_000

    // MARK: Gesture state machine

    private enum Gesture {
        case idle          // nothing happening
        case deciding      // key down; waiting to see click vs hold
        case tapRecording  // click-to-start toggle session, recording (polish)
        case holdRecording // push-to-talk, key held, recording (no polish)
    }
    private var gesture: Gesture = .idle
    private var holdTask: Task<Void, Never>?
    /// Still held past this → push-to-talk (no polish). Released sooner → it was a
    /// click, which starts a click-to-stop toggle session (with polish).
    private let holdThreshold: UInt64 = 250_000_000   // 0.25s

    init(store: SettingsStore, queue: DictationQueue, recording: RecordingState) {
        self.store = store
        self.queue = queue
        self.recording = recording
        recording.onCancel = { [weak self] in self?.cancel() }
        recording.onCommit = { [weak self] in self?.commit() }
        pill.onNoticeAction = { [weak self] in self?.cancel() }
    }

    // MARK: - Hotkey gesture entry points

    /// Bound hotkey pressed down. A new recording can begin even while previous
    /// utterances are still processing — those run in the background queue.
    func hotkeyDown() {
        switch gesture {
        case .idle:
            // Show the capsule and start capturing the INSTANT the key goes down —
            // don't wait to classify the gesture, or there's a perceptible press
            // latency. Click-vs-hold only decides polish, which isn't needed until
            // commit, so resolve it lazily (assume "click" until proven a hold).
            guard confirmRecording() else { return }
            beginCapture()
            polishThisSession = true
            gesture = .deciding
            holdTask?.cancel()
            let threshold = holdThreshold
            holdTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: threshold)
                guard let self, !Task.isCancelled, self.gesture == .deciding else { return }
                // Still held past the threshold → push-to-talk: no polish.
                self.gesture = .holdRecording
                self.polishThisSession = false
                self.playFeedback(.holdPress)
            }

        case .tapRecording:
            // A second click ends the toggle session.
            commit()

        case .deciding, .holdRecording:
            break
        }
    }

    /// Bound hotkey released.
    func hotkeyUp() {
        switch gesture {
        case .holdRecording:
            // Push-to-talk release → finish (no polish).
            commit()

        case .deciding:
            // Released before the threshold → it was a click: a hands-free toggle
            // that records until the next click (with polish). Capsule already up.
            holdTask?.cancel(); holdTask = nil
            gesture = .tapRecording
            polishThisSession = true
            playFeedback(.clickStart)

        case .idle, .tapRecording:
            break
        }
    }

    func handleEscape() {
        if active || capturing {
            cancel()
        } else if pill.isNoticeVisible {
            pill.hideNotice()
        } else {
            // Not recording → Esc cancels the in-flight conversion (front card).
            queue.cancelNewest()
        }
    }

    /// Menu-bar "开始 / 停止听写": behaves as the click-to-stop toggle session
    /// (polish on, since that's the richer mode).
    func toggleFromMenu() {
        if active {
            commit()
        } else {
            cancelGestureTimers()
            guard confirmRecording() else { return }
            beginCapture()
            polishThisSession = true
            gesture = .tapRecording
            playFeedback(.clickStart)
        }
    }

    // MARK: - Recording lifecycle

    /// Validate + show the recording capsule immediately. Returns false (after
    /// surfacing an error) if no ASR model is configured.
    @discardableResult
    private func confirmRecording() -> Bool {
        guard let asr = store.settings.asrModel,
              store.settings.resolve(asr) != nil else {
            fail("未选择语音识别模型，请在「模型」里添加并选择。")
            return false
        }
        // Capture the focused app now, while the user's target is still frontmost.
        frontApp = NSWorkspace.shared.frontmostApplication?.localizedName
        // …and wake its AX tree now, so an Electron app's focused-element query has
        // resolved by the time we deliver (else the first insert misses + parks).
        TextInserter.primeFocusedAppAccessibility()
        active = true
        pill.hideNotice()
        recording.level.reset()
        recording.active = true
        return true
    }

    /// Start the microphone. The engine is started OFF the main thread so the
    /// capsule (already shown by `confirmRecording`) doesn't wait on audio setup —
    /// that first-start can cost 100ms+ and would otherwise read as press latency.
    private func beginCapture() {
        guard !capturing else { return }
        capturing = true
        sink.reset()

        let sink = self.sink
        let capture = AudioCapture(targetRate: httpRate) { [weak self] frame in
            sink.append(frame)
            let level = AudioCapture.level(frame)
            Task { @MainActor in
                guard let self, self.active else { return }
                self.recording.level.push(level)
            }
        }
        self.capture = capture
        Task.detached {
            do {
                try capture.start()
            } catch {
                await MainActor.run { [weak self] in
                    self?.fail("无法开始录音：\(error.localizedDescription)")
                }
            }
        }
    }

    func commit() {
        guard active else { return }
        // The stop cue depends on which gesture this session was: a held key that's
        // now released vs. a click-to-stop on a hands-free toggle.
        playFeedback(gesture == .holdRecording ? .holdRelease : .clickStop)
        let polish = polishThisSession
        let app = frontApp
        gesture = .idle
        cancelGestureTimers()
        capture?.stop()
        capture = nil
        capturing = false
        active = false

        guard let asr = store.settings.asrModel,
              store.settings.resolve(asr) != nil else {
            sink.reset()
            fail("识别模型缺失。")
            return
        }

        // Hand the audio to the background queue and free the engine at once: the
        // user can start the next recording immediately. The just-recorded capsule
        // becomes a conversion card in the same deck.
        let samples = sink.drain()
        recording.active = false
        guard !samples.isEmpty else { return }
        queue.submit(samples: samples, rate: httpRate, polish: polish, frontApp: app)
    }

    /// Cancel the *current recording* only — in-flight queue jobs keep going.
    func cancel() {
        cancelGestureTimers()
        gesture = .idle
        capture?.stop()
        capture = nil
        capturing = false
        sink.reset()
        finishIdle()
    }

    // MARK: - Helpers

    /// Play the cue bound to a feedback event, if sounds are enabled.
    private func playFeedback(_ event: FeedbackEvent) {
        let fb = store.settings.feedbackSounds
        guard fb.enabled, let cue = fb.cue(for: event) else { return }
        sounds.play(cue, masterVolume: fb.masterVolume)
    }

    private func cancelGestureTimers() {
        holdTask?.cancel(); holdTask = nil
    }

    private func fail(_ message: String) {
        NSLog("[dictation] \(message)")
        cancelGestureTimers()
        gesture = .idle
        capture?.stop()
        capture = nil
        capturing = false
        active = false
        recording.active = false

        let notice = noticeParts(from: message)
        pill.showNotice(
            title: notice.title,
            message: notice.message,
            actionTitle: "关闭",
            autoDismissAfter: 4
        )
    }

    private func noticeParts(from message: String) -> (title: String, message: String) {
        for separator in ["：", "，", ":"] {
            if let range = message.range(of: separator) {
                let title = String(message[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                let body = String(message[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
                if !title.isEmpty, !body.isEmpty {
                    return (title, body)
                }
            }
        }
        return ("Orbit遇到问题", message)
    }

    private func finishIdle() {
        active = false
        capturing = false
        gesture = .idle
        recording.active = false
        pill.hideNotice()
    }
}
