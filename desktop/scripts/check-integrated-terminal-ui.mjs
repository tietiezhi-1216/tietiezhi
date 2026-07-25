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
  const { IntegratedTerminalPanel, normalizeTerminalText } =
    await server.ssrLoadModule(
      "/src/features/chat/integrated-terminal-panel.tsx",
    );
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(IntegratedTerminalPanel, {
        taskId: "00000000-0000-4000-8000-000000000030",
      }),
    ),
  );
  if (!html.includes("Terminal")) {
    throw new Error("集成终端没有渲染折叠入口");
  }
  const normalized = normalizeTerminalText(
    "\u001b[31mred\u001b[0m\r\nabc\bD",
  );
  if (normalized !== "red\nabD") {
    throw new Error(`终端控制序列规范化错误：${JSON.stringify(normalized)}`);
  }
  const source = fs.readFileSync(
    new URL("../src/features/chat/integrated-terminal-panel.tsx", import.meta.url),
    "utf8",
  );
  for (const label of [
    "新建终端",
    "输入命令并回车",
    "Ctrl+C",
    "terminalResize",
    "terminalTerminate",
    "terminalClose",
  ]) {
    if (!source.includes(label)) {
      throw new Error(`集成终端缺少交互：${label}`);
    }
  }
  process.stdout.write("integrated terminal SSR verification passed\n");
} finally {
  await server.close();
}
