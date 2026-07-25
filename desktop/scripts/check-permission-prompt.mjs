import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { PermissionPrompt } = await server.ssrLoadModule(
    "/src/features/chat/permission-prompt.tsx",
  );
  const item = {
    id: 1,
    kind: "permission",
    requestId: "perm-1",
    tool: "bash",
    description: "执行命令：cargo test",
    args: { command: "cargo test" },
    scope: "命令：cargo test",
    createdAt: Date.now(),
  };
  const html = renderToStaticMarkup(
    React.createElement(PermissionPrompt, { item }),
  );
  for (const label of [
    "命令：cargo test",
    "允许一次",
    "本作用域允许",
    "拒绝并继续",
    "停止任务",
  ]) {
    if (!html.includes(label)) {
      throw new Error(`审批界面缺少内容：${label}`);
    }
  }
  process.stdout.write("permission prompt SSR verification passed\n");
} finally {
  await server.close();
}
