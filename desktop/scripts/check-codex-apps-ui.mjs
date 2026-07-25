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
  const { CodexAppsPanel } = await server.ssrLoadModule(
    "/src/features/chat/codex-apps-panel.tsx",
  );
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(CodexAppsPanel, {
        threadId: "00000000-0000-7000-8000-000000000033",
      }),
    ),
  );
  if (!html.includes("Apps")) {
    throw new Error("Apps 面板没有渲染入口");
  }
  const source = fs.readFileSync(
    new URL("../src/features/chat/codex-apps-panel.tsx", import.meta.url),
    "utf8",
  );
  const apiSource = fs.readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  for (const label of [
    "Apps 与连接器",
    "Dynamic Tools",
    "审批、Hook 与 Item 生命周期",
    "forceRefetch",
  ]) {
    if (!`${source}\n${apiSource}`.includes(label)) {
      throw new Error(`Apps UI 缺少行为证据：${label}`);
    }
  }
  const workspace = fs.readFileSync(
    new URL("../src/features/chat/workspace-mode-panel.tsx", import.meta.url),
    "utf8",
  );
  if (!workspace.includes("<CodexAppsPanel")) {
    throw new Error("Apps 面板没有接入当前 Thread 工作区");
  }
  process.stdout.write("Codex Apps SSR verification passed\n");
} finally {
  await server.close();
}
