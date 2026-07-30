/**
 * Line diff for the agent's file changes.
 *
 * Runs in the renderer on purpose: the main process would have to serialize the
 * result on top of the file text it already sends, and here it can be computed
 * only when a tool entry is actually expanded.
 *
 * No dependency — a line-level LCS is ~80 lines, and the three guards below are
 * what a library would give us anyway:
 *   1. identical leading/trailing lines are stripped before the LCS, which is
 *      what makes a two-line edit in a 5000-line file cheap;
 *   2. beyond `MAX_LCS_CELLS` the middle is paired positionally instead, since a
 *      quadratic table over a full rewrite freezes the tab;
 *   3. beyond `MAX_DIFF_LINES` *rendered* rows the result is truncated, because
 *      nobody reads 4000 rows and React still has to mount every one of them.
 */

import type { FileChange } from "./types";

/** Two 2000-line blocks after stripping. An Int32Array of this is ~16MB. */
const MAX_LCS_CELLS = 4_000_000;
/** Hard cap on emitted rows. */
export const MAX_DIFF_LINES = 4_000;
/** Unchanged runs longer than this collapse. */
const FOLD_THRESHOLD = 8;
/** Unchanged lines kept visible on each side of a change. */
const FOLD_CONTEXT = 3;

export type LineChange = "context" | "add" | "remove";

export interface DiffLine {
  change: LineChange;
  /** 1-based line number in the old file; null for added lines. */
  beforeLine: number | null;
  /** 1-based line number in the new file; null for removed lines. */
  afterLine: number | null;
  text: string;
}

/** A run the view renders, or one it hides behind "⋯ N 行未改动". */
export type DiffSection =
  | { kind: "lines"; lines: DiffLine[] }
  | { kind: "fold"; lines: DiffLine[] };

export interface FileDiff {
  path: string;
  sections: DiffSection[];
  added: number;
  removed: number;
  /** True when the file did not exist before. */
  created: boolean;
  /** True when both sides are byte-identical. */
  identical: boolean;
  /** True when the LCS was skipped and lines were paired positionally. */
  degraded: boolean;
  /** True when rows past `MAX_DIFF_LINES` were dropped from `sections`. */
  truncated: boolean;
}

/**
 * Validates an event `detail` as a file change.
 *
 * The payload crosses a process boundary, so its shape is checked rather than
 * asserted: a renderer that trusts the wire crashes on the first core change.
 */
export function parseFileChange(detail: unknown): FileChange | null {
  if (typeof detail !== "object" || detail === null) return null;
  const record = detail as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string") return null;

  if (record["kind"] === "file-change") {
    const before = record["before"];
    const after = record["after"];
    if (typeof after !== "string") return null;
    if (before !== null && typeof before !== "string") return null;
    return { kind: "file-change", path, before, after };
  }
  if (record["kind"] === "file-change-skipped") {
    const bytes = record["bytes"];
    return {
      kind: "file-change-skipped",
      path,
      reason: "too-large",
      bytes: typeof bytes === "number" ? bytes : 0,
    };
  }
  return null;
}

/**
 * Splits file text into lines.
 *
 * A trailing newline does not become an empty last line: otherwise every diff
 * would end with a phantom blank row. The cost is that adding or removing only
 * the final newline reads as no change, which `identical` still reports.
 */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest common subsequence over line arrays, as a boolean pair-up.
 *
 * Returns the emitted lines for the middle section. Caller guarantees the size
 * is within `MAX_LCS_CELLS`.
 */
function lcsLines(
  before: string[],
  after: string[],
  beforeOffset: number,
  afterOffset: number,
): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  // Flat typed array rather than nested arrays: a 2000x2000 table of JS arrays
  // costs several times the memory and allocates 2000 objects.
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        before[i] === after[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const left = before[i] as string;
    const right = after[j] as string;
    if (left === right) {
      lines.push({
        change: "context",
        beforeLine: beforeOffset + i + 1,
        afterLine: afterOffset + j + 1,
        text: left,
      });
      i += 1;
      j += 1;
      continue;
    }
    // Ties favour deletions first, so a replaced line reads as "- old / + new".
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ change: "remove", beforeLine: beforeOffset + i + 1, afterLine: null, text: left });
      i += 1;
    } else {
      lines.push({ change: "add", beforeLine: null, afterLine: afterOffset + j + 1, text: right });
      j += 1;
    }
  }
  while (i < n) {
    lines.push({
      change: "remove",
      beforeLine: beforeOffset + i + 1,
      afterLine: null,
      text: before[i] as string,
    });
    i += 1;
  }
  while (j < m) {
    lines.push({
      change: "add",
      beforeLine: null,
      afterLine: afterOffset + j + 1,
      text: after[j] as string,
    });
    j += 1;
  }
  return lines;
}

/** Positional fallback: pair line i with line i and mark every mismatch. */
function pairwiseLines(
  before: string[],
  after: string[],
  beforeOffset: number,
  afterOffset: number,
): DiffLine[] {
  const lines: DiffLine[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left !== undefined && right !== undefined && left === right) {
      lines.push({
        change: "context",
        beforeLine: beforeOffset + index + 1,
        afterLine: afterOffset + index + 1,
        text: left,
      });
      continue;
    }
    if (left !== undefined) {
      lines.push({
        change: "remove",
        beforeLine: beforeOffset + index + 1,
        afterLine: null,
        text: left,
      });
    }
    if (right !== undefined) {
      lines.push({
        change: "add",
        beforeLine: null,
        afterLine: afterOffset + index + 1,
        text: right,
      });
    }
  }
  return lines;
}

/** Groups the flat line list, folding unchanged runs that are long enough. */
function sectionize(lines: DiffLine[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.change !== "context") {
      const start = index;
      while (index < lines.length && lines[index]?.change !== "context") index += 1;
      sections.push({ kind: "lines", lines: lines.slice(start, index) });
      continue;
    }

    const start = index;
    while (index < lines.length && lines[index]?.change === "context") index += 1;
    const run = lines.slice(start, index);
    const atStart = start === 0;
    const atEnd = index >= lines.length;
    // Context is only useful next to a change: a run at the top or bottom of the
    // file needs it on one side, an interior run on both.
    const head = atStart ? 0 : FOLD_CONTEXT;
    const tail = atEnd ? 0 : FOLD_CONTEXT;
    if (run.length <= Math.max(head + tail, FOLD_THRESHOLD)) {
      sections.push({ kind: "lines", lines: run });
      continue;
    }
    if (head > 0) sections.push({ kind: "lines", lines: run.slice(0, head) });
    sections.push({ kind: "fold", lines: run.slice(head, run.length - tail) });
    if (tail > 0) sections.push({ kind: "lines", lines: run.slice(run.length - tail) });
  }
  return sections;
}

/**
 * Diffs one file change.
 *
 * `before === null` means the file was created, which renders as all additions.
 */
export function computeFileDiff(path: string, before: string | null, after: string): FileDiff {
  const beforeLines = toLines(before ?? "");
  const afterLines = toLines(after);

  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const beforeMid = beforeLines.slice(head, beforeLines.length - tail);
  const afterMid = afterLines.slice(head, afterLines.length - tail);
  const degraded = (beforeMid.length + 1) * (afterMid.length + 1) > MAX_LCS_CELLS;
  const middle = degraded
    ? pairwiseLines(beforeMid, afterMid, head, head)
    : lcsLines(beforeMid, afterMid, head, head);

  const lines: DiffLine[] = [];
  for (let index = 0; index < head; index += 1) {
    lines.push({
      change: "context",
      beforeLine: index + 1,
      afterLine: index + 1,
      text: beforeLines[index] as string,
    });
  }
  lines.push(...middle);
  for (let index = 0; index < tail; index += 1) {
    const beforeAt = beforeLines.length - tail + index;
    const afterAt = afterLines.length - tail + index;
    lines.push({
      change: "context",
      beforeLine: beforeAt + 1,
      afterLine: afterAt + 1,
      text: beforeLines[beforeAt] as string,
    });
  }

  // Counted over every line, not the kept ones: the header should report the
  // real size of the change even when the view below it is cut short.
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.change === "add") added += 1;
    else if (line.change === "remove") removed += 1;
  }

  const capped = capSections(sectionize(lines));
  return {
    path,
    sections: capped.sections,
    added,
    removed,
    created: before === null,
    identical: before === after,
    degraded,
    truncated: capped.truncated,
  };
}

/**
 * Caps how many rows the view can mount.
 *
 * Counts rendered rows, so a folded run costs one no matter how long it is.
 * Capping raw line count instead would drop the one changed line of a
 * 10000-line file — the only part anyone opened the diff to see.
 */
function capSections(sections: DiffSection[]): { sections: DiffSection[]; truncated: boolean } {
  let rows = 0;
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) break;
    const cost = section.kind === "fold" ? 1 : section.lines.length;
    if (rows + cost <= MAX_DIFF_LINES) {
      rows += cost;
      continue;
    }
    const room = MAX_DIFF_LINES - rows;
    const head = sections.slice(0, index);
    if (section.kind === "lines" && room > 0) {
      head.push({ kind: "lines", lines: section.lines.slice(0, room) });
    }
    return { sections: head, truncated: true };
  }
  return { sections, truncated: false };
}
