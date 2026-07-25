import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { CodexApprovalPrompt, codexApprovalResponse } =
    await server.ssrLoadModule(
      "/src/features/chat/codex-approval-prompt.tsx",
    );
  const request = {
    recipients: ["desktop"],
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "call",
      command: "cargo test",
      cwd: "/tmp/project",
      startedAtMs: 42,
    },
  };
  const html = renderToStaticMarkup(
    React.createElement(CodexApprovalPrompt, {
      request,
      onRespond() {},
    }),
  );
  for (const label of [
    "cargo test",
    "允许一次",
    "本作用域允许",
    "拒绝并继续",
    "停止任务",
  ]) {
    if (!html.includes(label)) {
      throw new Error(`Codex 审批界面缺少内容：${label}`);
    }
  }
  const response = codexApprovalResponse(request, "acceptForSession");
  if (response.result.decision !== "acceptForSession") {
    throw new Error("Codex 会话审批响应不符合 V2");
  }
  process.stdout.write("Codex approval prompt SSR verification passed\n");
} finally {
  await server.close();
}
