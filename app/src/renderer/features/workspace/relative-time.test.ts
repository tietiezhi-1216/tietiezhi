import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./relative-time";

describe("formatRelativeTime", () => {
  const now = new Date("2026-08-02T12:00:00+08:00").getTime();

  it("展示刚刚、分钟和小时", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3 分钟前");
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now)).toBe("2 小时前");
  });

  it("超过一周后回退到日期", () => {
    expect(formatRelativeTime(now - 8 * 24 * 60 * 60_000, now)).toMatch(/7|25/);
  });
});
