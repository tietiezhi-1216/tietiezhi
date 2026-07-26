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
  const { WorkspaceToolsPanel } = await server.ssrLoadModule(
    "/src/features/chat/workspace-tools-panel.tsx",
  );
  const { useChatStore } = await server.ssrLoadModule("/src/stores/chat.ts");
  useChatStore.setState({
    activeId: "00000000-0000-4000-8000-000000000041",
    taskMode: "code",
    streaming: false,
  });
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(WorkspaceToolsPanel, {
        taskId: "00000000-0000-4000-8000-000000000041",
        taskMode: "code",
      }),
    ),
  );
  for (const label of ["工作区", "Code", "Remote &amp; Realtime", "Terminal"]) {
    if (!html.includes(label)) {
      throw new Error(`右侧工作区面板缺少内容：${label}`);
    }
  }
  if (!html.includes('aria-label="收起工作区面板"')) {
    throw new Error("右侧工作区面板缺少收起入口");
  }

  const chatSource = fs.readFileSync(
    new URL("../src/features/chat/chat-page.tsx", import.meta.url),
    "utf8",
  );
  const composerPosition = chatSource.indexOf("<ChatComposerSurface");
  const panelPosition = chatSource.indexOf("<WorkspaceToolsPanel");
  if (composerPosition < 0 || panelPosition < composerPosition) {
    throw new Error("工作区工具仍位于输入框上方");
  }
  const headerSource = fs.readFileSync(
    new URL("../src/App.tsx", import.meta.url),
    "utf8",
  );
  for (const evidence of [
    "toggleWorkspacePanel",
    "展开工作区面板",
    "收起工作区面板",
  ]) {
    if (!headerSource.includes(evidence)) {
      throw new Error(`标题栏缺少工作区面板交互：${evidence}`);
    }
  }
  process.stdout.write("workspace tools side panel SSR verification passed\n");
} finally {
  await server.close();
}
