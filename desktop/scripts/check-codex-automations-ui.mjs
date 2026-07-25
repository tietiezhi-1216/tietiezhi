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
  const { AutomationList } = await server.ssrLoadModule(
    "/src/features/automations/automation-list.tsx",
  );
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(AutomationList),
    ),
  );
  if (!html.includes("工作流") || !html.includes("运行记录")) {
    throw new Error("Automation 控制面没有渲染工作流和运行记录入口");
  }
  const sources = [
    "../src/features/automations/automation-list.tsx",
    "../src/features/automations/automation-editor.tsx",
    "../src/features/automations/node-inspector.tsx",
    "../src/lib/api.ts",
  ]
    .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  for (const evidence of [
    "发布并启用",
    "暂停定时运行",
    "恢复定时运行",
    "cancelAutomationRun",
    "Thread",
    "Turn",
    "Worktree",
    "approvalPolicy=never",
    "Git 项目目录",
  ]) {
    if (!sources.includes(evidence)) {
      throw new Error(`Automation UI 缺少行为证据：${evidence}`);
    }
  }
  process.stdout.write("Codex Automations SSR verification passed\n");
} finally {
  await server.close();
}
