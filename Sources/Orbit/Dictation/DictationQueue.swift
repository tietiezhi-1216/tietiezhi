//  DictationQueue.swift
//  Concurrent dictation: recording stays serial (one mic, one mouth), but each
//  finished utterance becomes an independent Job that transcribes + polishes in
//  the background, so the user can immediately start the next recording.
//
//  Three stages:
//   • submit  — engine hands off captured audio as a Job (monotonic `seq`).
//   • process — each Job runs ASR → (optional) polish concurrently (capped).
//   • deliver — a single ordered cursor releases results in spoken order: if an
//     editable field is focused it pastes at the cursor; otherwise the result
//     parks in the on-screen result stack for manual copy / insert.
//
//  Ordered delivery also serializes the ⌘V pastes — two results never fight over
//  the clipboard.

import Foundation
import Combine

/// Live state of the in-progress recording — the front "card" of the unified
/// dictation deck. Split from the per-frame audio level (a separate object) so the
/// deck doesn't re-layout on every audio buffer; only the level bars do.
@MainActor
final class RecordingState: ObservableObject {
    @Published var active = false
    let level = RecordingLevel()
    var onCancel: (() -> Void)?
    var onCommit: (() -> Void)?
}

/// Per-frame mic loudness, smoothed and published. `value` is the single amplitude
/// the waveform shapes itself around (a bell envelope + amplitude-gated ripple in
/// the view); the loudness is perceptually mapped + gated upstream by
/// `AudioCapture.level`, so silence pushes 0 → the wave collapses to a flat line.
@MainActor
final class RecordingLevel: ObservableObject {
    /// Latest smoothed loudness (0…1).
    @Published var value: Float = 0
    private var smoothed: Float = 0

    /// Feed a fresh mic loudness. Fast attack so the wave leaps to speech, slower
    /// release so it eases back to rest (no flicker between syllables).
    func push(_ level: Float) {
        let target = min(1, max(0, level))
        let k: Float = target > smoothed ? 0.5 : 0.18   // attack vs release
        smoothed += (target - smoothed) * k
        value = smoothed
    }

    /// Back to rest — called whenever a recording starts or stops.
    func reset() {
        smoothed = 0
        value = 0
    }
}

/// One utterance moving through the pipeline. Observable so its deck card updates
/// live (status, streamed polish text).
@MainActor
final class DictationJob: ObservableObject, Identifiable {
    let id = UUID()
    let date = Date()
    let seq: Int
    let polish: Bool
    let frontApp: String?
    let samples: [Int16]
    let rate: Int

    enum Phase: Equatable { case transcribing, polishing, done, failed }

    @Published var phase: Phase = .transcribing
    @Published var statusLabel: String = "Translate…"
    /// The stage word the ticker builds `statusLabel` from ("Translate" /
    /// "Translate 2/3" / "Thinking"); the ticker appends a slow hint only.
    var statusBase: String = "Translate"
    @Published var streamText: String = ""
    @Published var result: String = ""
    @Published var failure: String?
    /// Delivered by auto-insert (pasted at the cursor).
    @Published var inserted = false
    /// Delivered to the manual stack (no editable field was focused).
    @Published var queued = false

    var transcript: String = ""
    var polishedOut: String?
    var modeTag: String?
    /// Per-stage retained files: audio immediately, transcript after ASR, polish after LLM.
    var artifacts: DictationArtifactPaths?
    /// User cancelled this job mid-flight; its result is dropped (but the delivery
    /// cursor still advances past it so later jobs aren't stalled).
    var cancelled = false
    var historyRecorded = false
    /// Guards `markReady` so a job is only ever released to delivery once.
    var readied = false

    init(seq: Int, polish: Bool, frontApp: String?, samples: [Int16], rate: Int) {
        self.seq = seq
        self.polish = polish
        self.frontApp = frontApp
        self.samples = samples
        self.rate = rate
    }
}

@MainActor
final class DictationQueue: ObservableObject {
    /// The jobs currently shown in the result stack (in flight, or delivered and
    /// awaiting manual action / auto-fade). Ordered oldest → newest by `seq`.
    @Published private(set) var cards: [DictationJob] = []

    private let store: SettingsStore
    private let history: DictationHistoryStore
    private let usage: UsageStore

    private var nextSeq = 0
    private var nextDeliverSeq = 0
    private var ready: [Int: DictationJob] = [:]
    private var pending: [DictationJob] = []
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var running = 0
    private var delivering = false
    private var didPromptAX = false

    private let maxConcurrent = 3

    init(store: SettingsStore, history: DictationHistoryStore, usage: UsageStore) {
        self.store = store
        self.history = history
        self.usage = usage
    }

    // MARK: - Submit

    /// Hand a finished recording off for background processing. Returns at once so
    /// the engine is free to record the next utterance.
    func submit(samples: [Int16], rate: Int, polish: Bool, frontApp: String?) {
        let job = DictationJob(seq: nextSeq, polish: polish, frontApp: frontApp,
                               samples: samples, rate: rate)
        job.artifacts = DictationAudioArchive.createSession(
            id: job.id.uuidString,
            date: job.date,
            samples: samples,
            rate: rate,
            seq: nextSeq,
            frontApp: frontApp,
            polish: polish
        )
        nextSeq += 1
        cards.append(job)
        pending.append(job)
        pump()
    }

    private func pump() {
        while running < maxConcurrent, !pending.isEmpty {
            let job = pending.removeFirst()
            running += 1
            tasks[job.id] = Task { @MainActor in
                await self.process(job)
                self.tasks[job.id] = nil
                self.running -= 1
                self.pump()
            }
        }
    }

    // MARK: - Process (ASR → polish)

    /// Live waiting feedback: compose the status label from the stage word plus
    /// elapsed seconds, escalating to "slow" hints so a long wait never looks
    /// frozen. Resets its clock whenever the phase flips (ASR → polish).
    private func startStatusTicker(_ job: DictationJob) -> Task<Void, Never> {
        Task { @MainActor in
            var phaseStart = Date()
            var lastPhase = job.phase
            while !Task.isCancelled {
                guard job.phase == .transcribing || job.phase == .polishing else { return }
                if job.phase != lastPhase {
                    lastPhase = job.phase
                    phaseStart = Date()
                }
                let s = Int(Date().timeIntervalSince(phaseStart))
                let base = job.statusBase
                switch s {
                case ..<10:  job.statusLabel = "\(base)…"
                case ..<25:  job.statusLabel = "\(base) · 响应较慢"
                default:     job.statusLabel = "\(base) · 仍在等待，按 esc 可取消"
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    private func process(_ job: DictationJob) async {
        let ticker = startStatusTicker(job)
        defer { ticker.cancel() }
        guard let asr = store.settings.asrModel,
              let resolved = store.settings.resolve(asr) else {
            job.failure = withAudioRecovery("识别模型缺失", job.artifacts)
            DictationAudioArchive.saveFailure(job.failure ?? "识别模型缺失", paths: job.artifacts)
            record(job, inserted: false, failure: job.failure)
            job.phase = .failed; markReady(job); return
        }
        do {
            let transcript = try await Transcriber.transcribe(
                resolved,
                samples: job.samples,
                rate: job.rate
            ) { index, total in
                await MainActor.run {
                    if total > 1 {
                        job.statusBase = "Translate \(index)/\(total)"
                    }
                }
            }.trimmed
            job.transcript = transcript
            DictationAudioArchive.saveTranscript(transcript, paths: job.artifacts)
            // Record ASR usage by audio duration (token-less; priced per minute).
            let audioSeconds = job.rate > 0 ? Double(job.samples.count) / Double(job.rate) : nil
            usage.add(store.settings.usageRecord(for: asr, source: "asr", date: Date(), audioSeconds: audioSeconds))
            guard !transcript.isEmpty else {
                job.failure = withAudioRecovery("没有识别到内容", job.artifacts)
                DictationAudioArchive.saveFailure(job.failure ?? "没有识别到内容", paths: job.artifacts)
                record(job, inserted: false, failure: job.failure)
                job.phase = .failed; markReady(job); return
            }

            // Polish only when the gesture asked for it AND a chat model exists.
            var polished: String?
            if job.polish,
               let llm = store.settings.llmModel,
               let resolvedLLM = store.settings.resolve(llm) {
                job.phase = .polishing
                job.statusBase = "Thinking"
                job.statusLabel = "Thinking…"
                job.streamText = ""
                let (system, user) = PromptComposer.compose(
                    settings: store.settings, transcript: transcript, frontApp: job.frontApp)
                do {
                    var streamed = ""
                    let (raw, polishUsage) = try await LLM.polishStreamMessages(
                        resolvedLLM, system: system, user: user
                    ) { piece in
                        streamed += piece
                        job.streamText = streamed
                    }
                    if !polishUsage.isEmpty {
                        usage.add(store.settings.usageRecord(
                            for: llm, source: "polish", date: Date(), usage: polishUsage))
                    }
                    let cleaned = store.settings.cleanOutput ? OutputCleaner.clean(raw) : raw
                    if !cleaned.isEmpty {
                        polished = cleaned
                        job.streamText = cleaned
                        DictationAudioArchive.savePolished(cleaned, paths: job.artifacts)
                    }
                } catch {
                    // Polish is best-effort: fall back to the raw transcript.
                    NSLog("[dictation] polish failed: \(error.localizedDescription)")
                    job.streamText = transcript
                }
            }

            job.polishedOut = polished
            job.result = (polished?.isEmpty == false) ? polished! : transcript
            job.modeTag = (polished != nil) ? (store.settings.activeTemplate?.name ?? "润色") : "raw"
            job.phase = .done
            markReady(job)
        } catch {
            job.failure = withAudioRecovery("识别失败：\(error.localizedDescription)", job.artifacts)
            DictationAudioArchive.saveFailure(job.failure ?? error.localizedDescription, paths: job.artifacts)
            record(job, inserted: false, failure: job.failure)
            job.phase = .failed
            markReady(job)
        }
    }

    // MARK: - Ordered delivery

    private func markReady(_ job: DictationJob) {
        guard !job.readied else { return }   // a job is released to delivery once
        job.readied = true
        ready[job.seq] = job
        deliverLoop()
    }

    /// Release ready jobs strictly in `seq` order. A single loop guarantees pastes
    /// happen one at a time (each `deliver` is awaited before the next).
    private func deliverLoop() {
        guard !delivering else { return }
        delivering = true
        Task { @MainActor in
            while let job = ready[nextDeliverSeq] {
                ready[nextDeliverSeq] = nil
                await deliver(job)
                nextDeliverSeq += 1
            }
            delivering = false
        }
    }

    private func deliver(_ job: DictationJob) async {
        if job.cancelled {
            // User dropped it — card is already gone; just let the cursor advance.
            return
        }
        if job.phase == .failed {
            // The failed card stays for the user to dismiss; nothing to record.
            return
        }
        if TextInserter.isEditableFieldFocused() {
            _ = await TextInserter.insertAwaiting(job.result)
            job.inserted = true
            record(job, inserted: true)
            scheduleRemoval(job, after: 1.6)
        } else {
            job.queued = true
            record(job, inserted: false)
            // Surface the system grant dialog once if the only reason we can't
            // auto-insert is the missing Accessibility permission.
            if !TextInserter.canAutoInsert, !didPromptAX {
                didPromptAX = true
                Permissions.promptAccessibility()
            }
        }
    }

    private func record(_ job: DictationJob, inserted: Bool) {
        record(job, inserted: inserted, failure: nil)
    }

    private func record(_ job: DictationJob, inserted: Bool, failure: String?) {
        guard !job.historyRecorded else { return }
        job.historyRecorded = true
        history.add(DictationEntry(
            id: job.id.uuidString,
            date: job.date,
            transcript: job.transcript,
            polished: job.polishedOut,
            inserted: inserted,
            mode: job.modeTag,
            failure: failure,
            artifacts: job.artifacts
        ))
    }

    // MARK: - Manual actions (from the result-stack cards)

    func copy(_ job: DictationJob) {
        TextInserter.copyToPasteboard(job.result)
    }

    func manualInsert(_ job: DictationJob) {
        Task { @MainActor in
            if await TextInserter.insertAwaiting(job.result) {
                job.queued = false
                job.inserted = true
                scheduleRemoval(job, after: 1.2)
            } else {
                Permissions.promptAccessibility()
                Permissions.openAccessibilitySettings()
            }
        }
    }

    func dismiss(_ job: DictationJob) {
        cards.removeAll { $0.id == job.id }
    }

    /// Cancel a job mid-conversion (Esc / the card's ✗): stop its work, drop its
    /// card, and release the delivery cursor so later jobs aren't blocked.
    func cancelJob(_ job: DictationJob) {
        job.cancelled = true
        tasks[job.id]?.cancel()
        job.failure = withAudioRecovery("已取消", job.artifacts)
        DictationAudioArchive.saveFailure(job.failure ?? "已取消", paths: job.artifacts)
        record(job, inserted: false, failure: job.failure)
        cards.removeAll { $0.id == job.id }
        markReady(job)
    }

    /// Cancel/dismiss the front (newest) card — what Esc targets when not recording.
    func cancelNewest() {
        guard let job = cards.last else { return }
        switch job.phase {
        case .transcribing, .polishing: cancelJob(job)
        case .done, .failed:            dismiss(job)
        }
    }

    func clearAll() {
        cards.removeAll { $0.phase == .done || $0.phase == .failed }
    }

    private func scheduleRemoval(_ job: DictationJob, after seconds: Double) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            cards.removeAll { $0.id == job.id }
        }
    }

    private func withAudioRecovery(_ message: String, _ artifacts: DictationArtifactPaths?) -> String {
        guard let path = artifacts?.audioPath else { return message }
        return "\(message)；录音已保存：\(path)"
    }
}
