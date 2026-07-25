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
  const { WorkspaceGitPanel, GIT_REVIEW_PROMPT_EVENT } =
    await server.ssrLoadModule("/src/features/chat/workspace-git-panel.tsx");
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(WorkspaceGitPanel, {
        taskId: "00000000-0000-7000-8000-000000000032",
      }),
    ),
  );
  if (!html.includes("Diff")) {
    throw new Error("Git Diff 面板没有渲染入口");
  }
  if (GIT_REVIEW_PROMPT_EVENT !== "tietiezhi:git-review-prompt") {
    throw new Error("Git 审查意见事件不稳定");
  }
  const source = fs.readFileSync(
    new URL("../src/features/chat/workspace-git-panel.tsx", import.meta.url),
    "utf8",
  );
  for (const label of [
    "暂存",
    "取消暂存",
    "回退所选文件",
    "作为新一轮输入",
    "Commit",
    "Push",
    "Pull Request",
    "noopener,noreferrer",
  ]) {
    if (!source.includes(label)) {
      throw new Error(`Git Diff UI 缺少交互：${label}`);
    }
  }
  const chatSource = fs.readFileSync(
    new URL("../src/features/chat/chat-page.tsx", import.meta.url),
    "utf8",
  );
  if (
    !chatSource.includes("GIT_REVIEW_PROMPT_EVENT") ||
    !chatSource.includes("setInput(detail.prompt)")
  ) {
    throw new Error("Git 审查意见没有进入当前任务输入框");
  }
  process.stdout.write("workspace Git Diff SSR verification passed\n");
} finally {
  await server.close();
}
