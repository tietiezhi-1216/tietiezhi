import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, X } from "lucide-react";

import * as api from "@/lib/api";
import type { DictState } from "@/lib/types";

const BARS = 5;

const STATUS_LABELS: Record<string, string> = {
  recording: "录音中",
  transcribing: "识别中",
  polishing: "润色中",
  inserting: "输入中",
  idle: "完成",
  error: "出错",
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

export default function Pill() {
  const [st, setSt] = useState<DictState>({
    status: "recording",
    text: "",
    level: 0,
  });

  useEffect(() => {
    const pending = listen<DictState>("dictation://state", (e) =>
      setSt(e.payload),
    );
    return () => {
      pending.then((un) => un());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen select-none items-center justify-center">
      <div className="ring-white/10 flex h-12 w-[280px] items-center gap-2 rounded-full bg-neutral-900/90 px-2 text-neutral-100 shadow-lg ring-1 backdrop-blur">
        <button
          onClick={() => api.dictationCancel()}
          className="grid size-8 place-items-center rounded-full bg-white/5 transition-colors hover:bg-red-500/80"
          title="取消"
        >
          <X className="size-4" />
        </button>

        <div className="flex flex-1 items-center justify-center gap-2 overflow-hidden px-1">
          {st.text ? (
            <span className="truncate text-xs text-neutral-200" dir="auto">
              {st.text}
            </span>
          ) : (
            <div className="flex h-5 items-center gap-[3px]">
              {Array.from({ length: BARS }).map((_, i) => {
                const center = (BARS - 1) / 2;
                const falloff = 1 - Math.abs(i - center) / BARS;
                const h = Math.max(4, 4 + Math.round(st.level * 18 * falloff));
                return (
                  <span
                    key={i}
                    style={{ height: `${h}px` }}
                    className="w-[3px] rounded-full bg-emerald-400 transition-all duration-75"
                  />
                );
              })}
            </div>
          )}
          <span className="text-[10px] tracking-wide text-neutral-400">
            {statusLabel(st.status)}
          </span>
        </div>

        <button
          onClick={() => api.dictationToggle()}
          className="grid size-8 place-items-center rounded-full bg-emerald-500/90 transition-colors hover:bg-emerald-400"
          title="完成"
        >
          <Check className="size-4" />
        </button>
      </div>
    </div>
  );
}
