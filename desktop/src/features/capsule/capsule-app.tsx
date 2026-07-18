import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Check, CheckCircle2, Copy, Mic, X } from "lucide-react";
import {
  accessibilityTrusted,
  capsuleSetHeight,
  chatCancel,
  deliverText,
  dictationHotkey,
  dictationReset,
  errorMessage,
  hideCapsule,
  loadSettings,
  polishStream,
  showCapsule,
  transcribe,
} from "@/lib/api";
import type { AppSettings } from "@/lib/api";
import { startRecorder } from "@/lib/recorder";
import type { Recorder } from "@/lib/recorder";
import { formatShortcut } from "@/lib/shortcut";
import { cn } from "@/lib/utils";

/**
 * The floating dictation capsule: a black bottom-centered capsule with a
 * hairline border and big soft shadow. It morphs across the dictation lifecycle:
 *   • recording  — live mic level bars, with cancel / commit buttons;
 *   • processing — a light sweeps across it and a sky-blue glow arc rotates
 *     around its edge while ASR runs, then the polished text scrolls as a
 *     one-line ticker;
 *   • result     — a notice card above the pill (copy fallback when
 *     there was no caret to auto-insert into).
 */

const COMPACT_HEIGHT = 120;
const EXPANDED_HEIGHT = 600;

type Phase = "idle" | "recording" | "transcribing" | "polishing" | "result";

interface Result {
  text: string;
  error: boolean;
  needsAccessibility: boolean;
}

let nextRequestId = 1;

/** Progressive reveal decoupled from token arrival. */
function useTypewriter(target: string): string {
  const [shown, setShown] = useState(0);
  const targetRef = useRef(target);
  targetRef.current = target;

  if (target.length < shown) setShown(target.length);

  useEffect(() => {
    const id = window.setInterval(() => {
      setShown((s) => {
        const full = targetRef.current.length;
        if (s >= full) return s;
        return Math.min(full, s + Math.max(1, Math.floor((full - s) / 6)));
      });
    }, 26);
    return () => window.clearInterval(id);
  }, []);

  return target.slice(0, shown);
}

/**
 * Recording: live mic level bars. Heights are picked from a fixed set of
 * Tailwind classes (static strings so the scanner emits them) — the bar's target
 * pixel height maps to the nearest step, keeping this style-free.
 */
const BAR_HEIGHTS = [
  "h-[5px]",
  "h-[7px]",
  "h-[9px]",
  "h-[11px]",
  "h-[13px]",
  "h-[15px]",
  "h-[18px]",
  "h-[20px]",
  "h-[22px]",
] as const;
const BAR_PX = [5, 7, 9, 11, 13, 15, 18, 20, 22];

function nearestHeightClass(px: number): string {
  let best = 0;
  for (let i = 1; i < BAR_PX.length; i++) {
    if (Math.abs(BAR_PX[i] - px) < Math.abs(BAR_PX[best] - px)) best = i;
  }
  return BAR_HEIGHTS[best];
}

function LevelBars({ level }: { level: number }) {
  const bases = [7, 10, 14, 17, 20, 17, 14, 10, 7];
  return (
    <div className="mx-auto flex h-6 items-center gap-[1.6px]">
      {bases.map((base, i) => {
        const center = (bases.length - 1) / 2;
        const falloff = 1 - Math.abs(i - center) / bases.length;
        const h = Math.min(22, Math.max(5, base * 0.55 + level * 20 * falloff));
        return (
          <span
            key={i}
            className={cn(
              "w-[2px] rounded-full bg-white/95 transition-[height] duration-75",
              nearestHeightClass(h),
            )}
          />
        );
      })}
    </div>
  );
}

/** One-line ticker: freshest words stay visible; both ends fade out. */
function ScrollingLine({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [text]);

  return (
    <div
      ref={ref}
      className="flex h-full min-w-0 flex-1 items-center overflow-hidden [mask-image:linear-gradient(90deg,transparent_0%,black_9%,black_84%,transparent_100%)]"
    >
      <span className="mx-auto px-2 text-[13px] font-medium whitespace-nowrap text-white/95">
        {text.replace(/\s+/g, " ")}
      </span>
    </div>
  );
}

/** Status placeholder with a light sweeping across the glyphs. */
function ThinkingLabel({ text }: { text: string }) {
  return (
    <span className="relative mx-auto text-[13px] font-medium">
      <span className="text-white/45">{text}</span>
      <span
        aria-hidden
        className="animate-capsule-label-sweep absolute inset-0 text-white [mask-image:linear-gradient(90deg,transparent,black_40%,black_60%,transparent)] [mask-repeat:no-repeat] [mask-size:60%_100%]"
      >
        {text}
      </span>
    </span>
  );
}

/** Sweep light + rotating edge glow, only rendered while processing. */
function ThinkingBackground() {
  return (
    <>
      <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
        <span className="animate-capsule-sweep absolute inset-y-0 left-0 w-[42%] bg-gradient-to-r from-transparent via-white/[0.14] to-transparent mix-blend-plus-lighter" />
      </span>
      <span className="animate-capsule-glow pointer-events-none absolute inset-0 rounded-full p-[2.6px] blur-[2.6px] [background:conic-gradient(from_var(--capsule-glow-angle),transparent_0turn,transparent_0.58turn,rgba(107,199,255,0.65)_0.8turn,white_0.88turn,rgba(107,199,255,0.65)_0.96turn,transparent_1turn)] [mask:linear-gradient(#000_0_0)_content-box,linear-gradient(#000_0_0)] [mask-composite:exclude]" />
      <span className="animate-capsule-glow pointer-events-none absolute inset-0 rounded-full p-[1.2px] [background:conic-gradient(from_var(--capsule-glow-angle),transparent_0turn,transparent_0.58turn,rgba(107,199,255,0.65)_0.8turn,white_0.88turn,rgba(107,199,255,0.65)_0.96turn,transparent_1turn)] [mask:linear-gradient(#000_0_0)_content-box,linear-gradient(#000_0_0)] [mask-composite:exclude]" />
    </>
  );
}

/** Result card shown above the pill with the final text. */
function ResultCard({ result, onClose }: { result: Result; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(result.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };

  const title = result.error
    ? "听写遇到问题"
    : result.needsAccessibility
      ? "已复制（未获辅助功能权限）"
      : "已复制，可粘贴";

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-2 flex w-[304px] flex-col gap-2.5 rounded-[14px] bg-[#131212] px-[18px] pt-4 pb-[15px] shadow-[0_9px_40px_rgba(0,0,0,0.4)] ring-1 ring-white/[0.08] duration-300">
      <div className="flex items-center gap-2">
        {result.error ? (
          <AlertCircle className="size-[15px] shrink-0 text-[#F57A2E]" />
        ) : (
          <CheckCircle2 className="size-[15px] shrink-0 text-[#5CD985]" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{title}</span>
        <button
          onClick={onClose}
          aria-label="关闭"
          className="grid size-[18px] shrink-0 place-items-center text-white/[0.58] hover:text-white"
        >
          <X className="size-3" strokeWidth={3} />
        </button>
      </div>

      <div className="max-h-[380px] overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-white/[0.76] select-text">
        {result.text}
      </div>

      {!result.error && (
        <div className="flex justify-center pt-0.5">
          <button
            onClick={copy}
            className={cn(
              "flex h-[31px] items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold text-white",
              copied ? "bg-white/[0.18]" : "bg-white/25 hover:bg-white/30",
            )}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      )}
    </div>
  );
}

export function CapsuleApp() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(0);
  const [streamText, setStreamText] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [hotkey, setHotkey] = useState("⌥Space");

  const recorderRef = useRef<Recorder | null>(null);
  const requestIdRef = useRef<number | null>(null);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  const revealed = useTypewriter(streamText);
  const processing = phase === "transcribing" || phase === "polishing";
  const hasCard = result != null;

  // Window grows for the result card, shrinks back otherwise.
  useEffect(() => {
    void capsuleSetHeight(hasCard ? EXPANDED_HEIGHT : COMPACT_HEIGHT).catch(() => {});
  }, [hasCard]);

  const resetToIdle = () => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setLevel(0);
    setStreamText("");
    setPhase("idle");
  };

  const startSession = async () => {
    // Only start from a resting state, and never while a recorder is live.
    if (recorderRef.current || phaseRef.current === "recording" || processing) return;
    setResult(null);
    setStreamText("");

    let settings: AppSettings;
    try {
      settings = await loadSettings();
    } catch (err) {
      setResult({ text: errorMessage(err), error: true, needsAccessibility: false });
      return;
    }
    if (!settings.asrProviderId || !settings.asrModel) {
      setResult({
        text: "尚未选择语音识别模型，请在主窗口「设置 → 语音听写」里配置支持 ASR 的供应商（如小米 MiMo 的 mimo-v2.5-asr）。",
        error: true,
        needsAccessibility: false,
      });
      return;
    }

    try {
      recorderRef.current = await startRecorder(setLevel);
      setPhase("recording");
    } catch {
      setResult({
        text: "无法开始录音。请确认已授予麦克风权限（系统设置 → 隐私与安全性 → 麦克风）。",
        error: true,
        needsAccessibility: false,
      });
    }
  };

  const cancelSession = () => {
    if (requestIdRef.current != null) {
      void chatCancel(requestIdRef.current);
      requestIdRef.current = null;
    }
    resetToIdle();
    setResult(null);
    void dictationReset();
    void hideCapsule();
  };

  /**
   * Finish the recording and run the pipeline. `polish` comes from the gesture:
   * a click (hands-free) polishes, a hold (push-to-talk) delivers the raw
   * transcript.
   */
  const finish = async (polish: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || phaseRef.current !== "recording") return;
    recorderRef.current = null;

    let wavBase64: string;
    try {
      wavBase64 = recorder.stop();
    } catch (err) {
      setPhase("idle");
      setResult({ text: errorMessage(err), error: true, needsAccessibility: false });
      return;
    }

    const settings = await loadSettings().catch(() => null);
    if (!settings) {
      setPhase("idle");
      return;
    }

    setPhase("transcribing");
    let transcript: string;
    try {
      transcript = await transcribe({
        providerId: settings.asrProviderId,
        model: settings.asrModel,
        wavBase64,
        language: settings.outputLanguage || "auto",
      });
    } catch (err) {
      setPhase("idle");
      setResult({ text: errorMessage(err), error: true, needsAccessibility: false });
      return;
    }

    transcript = transcript.trim();
    if (!transcript) {
      setPhase("idle");
      setResult({ text: "没有识别到内容，请靠近麦克风再试一次。", error: true, needsAccessibility: false });
      return;
    }

    // Optional polish step — the gesture can opt out (push-to-talk).
    let finalText = transcript;
    if (polish && settings.polishEnabled && settings.polishProviderId && settings.polishModel) {
      setPhase("polishing");
      setStreamText("");
      const requestId = nextRequestId++;
      requestIdRef.current = requestId;
      let polished = "";
      let failed = false;
      try {
        await polishStream({
          requestId,
          providerId: settings.polishProviderId,
          model: settings.polishModel,
          transcript,
          options: { outputLanguage: settings.outputLanguage || "auto" },
          onEvent: (event) => {
            if (event.type === "delta") {
              polished += event.content;
              setStreamText(polished);
            } else if (event.type === "error") {
              failed = true;
            }
          },
        });
      } catch {
        failed = true;
      }
      requestIdRef.current = null;
      // Polish is best-effort: fall back to the raw transcript on failure.
      finalText = !failed && polished.trim() ? polished.trim() : transcript;
    }

    await deliver(finalText);
  };

  const deliver = async (text: string) => {
    // Hide first so the user's target app is frontmost and its field focused.
    await hideCapsule().catch(() => {});
    await new Promise((r) => window.setTimeout(r, 150));
    let res: Awaited<ReturnType<typeof deliverText>>;
    try {
      res = await deliverText(text);
    } catch {
      res = { inserted: false, needsAccessibility: false };
    }
    if (res.inserted) {
      // Landed at the caret; nothing to show.
      resetToIdle();
      return;
    }
    // No caret / no permission → show the copy card again.
    resetToIdle();
    setResult({ text, error: false, needsAccessibility: res.needsAccessibility });
    await showCapsule().catch(() => {});
  };

  // The Rust hotkey engine drives the session: it resolves the click-vs-hold
  // gesture and tells us when to start and how to finish. The capsule never
  // starts recording on its own — it's summoned, it does one session, it hides.
  useEffect(() => {
    const unlistenStart = listen("dictation:start", () => void startSession());
    const unlistenCommit = listen<boolean>("dictation:commit", (e) => {
      void finish(e.payload);
    });
    return () => {
      void unlistenStart.then((f) => f());
      void unlistenCommit.then((f) => f());
    };
  }, []);

  // Warm up the accessibility-permission check so the first insert isn't cold.
  useEffect(() => {
    void accessibilityTrusted().catch(() => {});
  }, []);

  // The trigger to show in the idle hint.
  useEffect(() => {
    void dictationHotkey()
      .then((s) => setHotkey(formatShortcut(s)))
      .catch(() => {});
  }, []);

  // Esc cancels. (The capsule never takes focus, so this only fires when the
  // user has deliberately clicked it; the hotkey is the primary control.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelSession();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const recording = phase === "recording";

  return (
    <div className="flex h-svh w-full flex-col items-center justify-end gap-2.5 pb-2.5 font-sans">
      {result && <ResultCard result={result} onClose={() => setResult(null)} />}

      <div
        className={cn(
          "relative flex h-[38px] w-[300px] shrink-0 items-center gap-2 rounded-full bg-black/90 shadow-[0_7px_32px_rgba(0,0,0,0.38)] ring-1 ring-white/[0.09]",
          processing ? "px-3.5" : "px-1.5",
        )}
      >
        {processing && <ThinkingBackground />}

        {/* Left button: cancel while recording, close otherwise. */}
        {!processing && (
          <button
            onClick={cancelSession}
            aria-label={recording ? "取消" : "关闭胶囊"}
            className="grid size-[26px] shrink-0 place-items-center rounded-full bg-white/[0.18] text-white/90 hover:bg-white/25"
          >
            <X className="size-3" strokeWidth={3} />
          </button>
        )}

        {/* Center content per phase. */}
        {recording ? (
          <LevelBars level={level} />
        ) : phase === "transcribing" ? (
          <ThinkingLabel text="识别中" />
        ) : phase === "polishing" ? (
          revealed ? (
            <ScrollingLine text={revealed} />
          ) : (
            <ThinkingLabel text="润色中" />
          )
        ) : (
          // idle: only reachable while a result card is up — the hotkey is how
          // you start another session.
          <span className="text-muted mx-auto flex items-center gap-1.5 text-[13px] font-medium text-white/45">
            <Mic className="size-3.5" /> 按 {hotkey} 再说一次
          </span>
        )}

        {/* Right button: commit while recording (a click → polish). */}
        {recording && (
          <button
            onClick={() => void finish(true)}
            aria-label="完成"
            className="grid size-[26px] shrink-0 place-items-center rounded-full bg-white/[0.94] text-black/[0.88] hover:bg-white"
          >
            <Check className="size-3.5" strokeWidth={3} />
          </button>
        )}
      </div>
    </div>
  );
}
