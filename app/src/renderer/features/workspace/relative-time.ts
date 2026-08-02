import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let snapshot = Date.now();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) snapshot = Date.now();
  listeners.add(listener);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      snapshot = Date.now();
      for (const notify of listeners) notify();
    }, 15_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useRelativeNow(): number {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
