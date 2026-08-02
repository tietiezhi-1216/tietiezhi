import type { WorkspaceDiffFile, WorkspaceDiffLine } from "@shared/contracts";

export function parseGitNumstat(output: string): Map<string, { additions: number | null; deletions: number | null }> {
  const result = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const [added, deleted, path] = record.split("\t");
    if (!path) continue;
    result.set(path, {
      additions: added === "-" ? null : Number(added ?? 0),
      deletions: deleted === "-" ? null : Number(deleted ?? 0),
    });
  }
  return result;
}

export function parseGitDiff(path: string, staged: boolean, output: string, truncated: boolean): WorkspaceDiffFile {
  const lines: WorkspaceDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let binary = false;
  for (const text of output.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "hunk", text });
    } else if (text.startsWith("Binary files") || text.startsWith("GIT binary patch")) {
      binary = true;
      lines.push({ kind: "meta", text });
    } else if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ") || text.startsWith("new file") || text.startsWith("deleted file") || text.startsWith("rename ")) {
      lines.push({ kind: "meta", text });
    } else if (text.startsWith("+")) {
      lines.push({ kind: "addition", text: text.slice(1), newLine });
      newLine += 1;
    } else if (text.startsWith("-")) {
      lines.push({ kind: "deletion", text: text.slice(1), oldLine });
      oldLine += 1;
    } else {
      lines.push({ kind: "context", text: text.startsWith(" ") ? text.slice(1) : text, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { path, staged, binary, truncated, lines };
}
