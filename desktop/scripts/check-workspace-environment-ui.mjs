import React from "react";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { WorkspaceModePanel } = await server.ssrLoadModule(
    "/src/features/chat/workspace-mode-panel.tsx",
  );
  const { useChatStore } = await server.ssrLoadModule("/src/stores/chat.ts");
  useChatStore.setState({
    activeId: "00000000-0000-4000-8000-000000000029",
    taskMode: "code",
    streaming: false,
  });
  const queryClient = new QueryClient();
  queryClient.setQueryData(
    ["task-workspace-overview", "00000000-0000-4000-8000-000000000029"],
    {
      work: {
        mode: "work",
        initialized: true,
        rootPath: "/tmp/worktree",
        isGit: true,
        fileCount: 2,
        fileCountCapped: false,
        changedFiles: ["src/main.rs"],
        deliverables: [],
        transferableFiles: [],
      },
      code: {
        mode: "code",
        initialized: true,
        rootPath: "/tmp/worktree",
        isGit: true,
        fileCount: 2,
        fileCountCapped: false,
        changedFiles: ["src/main.rs"],
        deliverables: [],
        transferableFiles: [],
      },
      environment: "worktree",
      initialized: true,
      rootPath: "/tmp/worktree",
      projectRoot: "/tmp/project",
      head: "1234567890abcdef",
      branch: null,
      detached: true,
      snapshots: [
        {
          id: "snapshot-1",
          label: "checkpoint",
          reference: "refs/tietiezhi/snapshots/task/snapshot-1",
          commit: "1234567890abcdef",
          createdAtMs: 1,
        },
      ],
      handoffs: [],
    },
  );
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(WorkspaceModePanel),
    ),
  );
  for (const label of ["Worktree", "Code"]) {
    if (!html.includes(label)) {
      throw new Error(`工作区环境界面缺少内容：${label}`);
    }
  }
  const source = fs.readFileSync(
    new URL("../src/features/chat/workspace-mode-panel.tsx", import.meta.url),
    "utf8",
  );
  for (const label of [
    "Local",
    "共享工作区变更",
    "创建快照",
    "恢复",
    "Handoff",
    "detached HEAD",
  ]) {
    if (!source.includes(label)) {
      throw new Error(`工作区环境交互缺少内容：${label}`);
    }
  }
  if (source.includes("从 Work 导入") || source.includes("从 Code 导入")) {
    throw new Error("工作区界面仍暴露旧双空间复制交互");
  }
  process.stdout.write("workspace environment SSR verification passed\n");
} finally {
  await server.close();
}
