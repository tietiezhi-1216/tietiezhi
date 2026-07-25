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
  const elicitation = {
    recipients: ["desktop"],
    id: "elicitation-1",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread",
      turnId: "turn",
      serverName: "fixture",
      mode: "form",
      message: "请选择发布环境",
      requestedSchema: {
        type: "object",
        properties: {
          environment: {
            type: "string",
            title: "发布环境",
            enum: ["staging", "production"],
          },
          confirm: {
            type: "boolean",
            title: "确认执行",
            default: true,
          },
        },
        required: ["environment", "confirm"],
      },
    },
  };
  const elicitationHtml = renderToStaticMarkup(
    React.createElement(CodexApprovalPrompt, {
      request: elicitation,
      onRespond() {},
    }),
  );
  for (const label of [
    "MCP 服务器需要你的输入",
    "请选择发布环境",
    "发布环境",
    "确认执行",
    "提交",
    "不提供并继续",
  ]) {
    if (!elicitationHtml.includes(label)) {
      throw new Error(`MCP Elicitation 界面缺少内容：${label}`);
    }
  }
  if (elicitationHtml.includes("本作用域允许")) {
    throw new Error("MCP Elicitation 不应显示会话授权入口");
  }
  const elicitationResponse = codexApprovalResponse(
    elicitation,
    "accept",
    { environment: "production", confirm: true },
  );
  if (
    elicitationResponse.result.action !== "accept" ||
    elicitationResponse.result.content.environment !== "production" ||
    elicitationResponse.result.content.confirm !== true
  ) {
    throw new Error("MCP Elicitation 响应不符合 V2");
  }
  process.stdout.write("Codex approval prompt SSR verification passed\n");
} finally {
  await server.close();
}
