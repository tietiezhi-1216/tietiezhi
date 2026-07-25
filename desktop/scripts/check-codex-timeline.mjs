import React from "react";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { reduceCodexTimeline } = await server.ssrLoadModule(
    "/src/stores/codex-timeline.ts",
  );
  const { CodexTimelineItem } = await server.ssrLoadModule(
    "/src/features/chat/codex-timeline.tsx",
  );
  const threadId = "00000000-0000-7000-8000-000000000031";
  const turnId = "00000000-0000-7000-8000-000000000032";
  const item = {
    type: "agentMessage",
    id: "message-1",
    text: "",
    phase: "commentary",
    memoryCitation: null,
  };
  let timeline = reduceCodexTimeline(undefined, {
    method: "item/started",
    recipients: ["desktop"],
    params: { threadId, turnId, item, startedAtMs: 1 },
  });
  timeline = reduceCodexTimeline(timeline, {
    method: "item/agentMessage/delta",
    recipients: ["desktop"],
    params: { threadId, turnId, itemId: item.id, delta: "继续" },
  });
  timeline = reduceCodexTimeline(timeline, {
    method: "item/completed",
    recipients: ["desktop"],
    params: {
      threadId,
      turnId,
      item: { ...item, text: "继续完成" },
      completedAtMs: 2,
    },
  });
  if (
    timeline.entries.length !== 1 ||
    timeline.entries[0].item.text !== "继续完成" ||
    timeline.entries[0].lifecycle !== "completed"
  ) {
    throw new Error("Codex Item 开始、增量和完成事件没有按 ID 合并");
  }

  const commandHtml = renderToStaticMarkup(
    React.createElement(CodexTimelineItem, {
      entry: {
        threadId,
        turnId,
        lifecycle: "completed",
        item: {
          type: "commandExecution",
          id: "command-1",
          command: "cargo test",
          cwd: "/tmp/project",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 12,
        },
      },
    }),
  );
  if (!commandHtml.includes("cargo test") || !commandHtml.includes("终端")) {
    throw new Error("CommandExecution 时间线卡片渲染失败");
  }

  const source = fs.readFileSync(
    new URL("../src/features/chat/codex-timeline.tsx", import.meta.url),
    "utf8",
  );
  for (const itemType of [
    "userMessage",
    "hookPrompt",
    "agentMessage",
    "plan",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "sleep",
    "imageGeneration",
    "enteredReviewMode",
    "exitedReviewMode",
    "contextCompaction",
  ]) {
    if (!source.includes(`${itemType}:`)) {
      throw new Error(`强类型时间线缺少 ThreadItem：${itemType}`);
    }
  }
  process.stdout.write("Codex typed timeline SSR verification passed\n");
} finally {
  await server.close();
}
