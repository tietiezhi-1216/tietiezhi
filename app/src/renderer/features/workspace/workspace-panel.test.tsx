import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopAPI } from "@shared/contracts";

import { WorkspacePanel } from "./workspace-panel";

const gitStatus = vi.fn();
const listDirectory = vi.fn();
const gitDiff = vi.fn();
const readFile = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    },
  });
  gitStatus.mockResolvedValue({
    repository: true,
    branch: "main",
    changes: [{
      path: "src/index.ts",
      status: "modified",
      staged: false,
      unstaged: true,
      additions: 3,
      deletions: 1,
    }],
  });
  listDirectory.mockImplementation((_conversationId: string, path?: string) => Promise.resolve(
    path === "src"
      ? [{ name: "index.ts", path: "src/index.ts", type: "file", hidden: false }]
      : [{ name: "src", path: "src", type: "directory", hidden: false }],
  ));
  gitDiff.mockResolvedValue({ path: "src/index.ts", staged: false, binary: false, truncated: false, lines: [] });
  readFile.mockResolvedValue("export {};\n");
  Object.defineProperty(window, "tietiezhi", {
    configurable: true,
    value: {
      workspace: { gitStatus, listDirectory, gitDiff, readFile },
    } as unknown as DesktopAPI,
  });
});

describe("WorkspacePanel", () => {
  it("右侧只提供变更和文件，不再出现工具页", async () => {
    render(<WorkspacePanel activeId="conversation-1" messages={[]} workspace={{ path: "/repo", name: "repo", temporary: false }} onClose={vi.fn()} />);
    expect(await screen.findByText("index.ts")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /变更/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "文件" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /工具/ })).toBeNull();
  });

  it("文件树按目录展开并在同一面板打开文件", async () => {
    render(<WorkspacePanel activeId="conversation-1" messages={[]} workspace={{ path: "/repo", name: "repo", temporary: false }} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: "文件" }));
    await userEvent.click(await screen.findByRole("button", { name: /src/ }));
    await userEvent.click(await screen.findByRole("button", { name: /index\.ts/ }));
    expect(await screen.findByText("export {};")).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith("conversation-1", "src/index.ts");
  });
});
