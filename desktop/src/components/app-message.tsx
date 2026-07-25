import { useEffect, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export type AppMessageTone = "success" | "info" | "warning" | "error";

interface AppMessageOptions {
  description?: string;
  tone?: AppMessageTone;
  duration?: number;
}

interface AppMessageEntry extends AppMessageOptions {
  id: number;
  title: string;
}

type MessageListener = (entry: AppMessageEntry) => void;

const listeners = new Set<MessageListener>();
let nextMessageId = 1;

export function showMessage(title: string, options: AppMessageOptions = {}) {
  const entry: AppMessageEntry = {
    id: nextMessageId++,
    title,
    tone: "info",
    duration: 4_000,
    ...options,
  };
  for (const listener of listeners) listener(entry);
}

export const message = {
  success: (title: string, description?: string) =>
    showMessage(title, { description, tone: "success" }),
  info: (title: string, description?: string) =>
    showMessage(title, { description, tone: "info" }),
  warning: (title: string, description?: string) =>
    showMessage(title, { description, tone: "warning" }),
  error: (title: string, description?: string) =>
    showMessage(title, { description, tone: "error" }),
};

const TONE_STYLES: Record<AppMessageTone, string> = {
  success: "border-emerald-500/30",
  info: "border-border",
  warning: "border-amber-500/35",
  error: "border-destructive/40",
};

const TONE_ICONS: Record<AppMessageTone, typeof Info> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
};

const TONE_ICON_STYLES: Record<AppMessageTone, string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  info: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
};

export function AppMessageHost() {
  const [entries, setEntries] = useState<AppMessageEntry[]>([]);

  useEffect(() => {
    const listener: MessageListener = (entry) => {
      setEntries((current) => [...current.slice(-3), entry]);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const dismiss = (id: number) => {
    setEntries((current) => current.filter((entry) => entry.id !== id));
  };

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {entries.map((entry) => {
        const tone = entry.tone ?? "info";
        const Icon = TONE_ICONS[tone];
        return (
          <ToastPrimitive.Root
            key={entry.id}
            open
            duration={entry.duration}
            onOpenChange={(open) => !open && dismiss(entry.id)}
            className={cn(
              "bg-popover text-popover-foreground pointer-events-auto grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl border px-4 py-3 shadow-lg",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2",
              "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-3",
              TONE_STYLES[tone],
            )}
          >
            <Icon className={cn("mt-0.5 size-4", TONE_ICON_STYLES[tone])} />
            <div className="min-w-0">
              <ToastPrimitive.Title className="text-sm font-medium">
                {entry.title}
              </ToastPrimitive.Title>
              {entry.description && (
                <ToastPrimitive.Description className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                  {entry.description}
                </ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="关闭提示"
              className="text-muted-foreground hover:bg-accent hover:text-foreground -mr-1 rounded-md p-1 transition-colors"
            >
              <X className="size-3.5" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed top-4 left-1/2 z-[200] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
