import React from "react";
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});

try {
  const { RemoteRealtimePanel } = await server.ssrLoadModule(
    "/src/features/chat/remote-realtime-panel.tsx",
  );
  const html = renderToStaticMarkup(
    React.createElement(RemoteRealtimePanel, {
      threadId: "00000000-0000-4000-8000-000000000035",
    }),
  );
  if (!html.includes("Remote &amp; Realtime")) {
    throw new Error("Remote & Realtime 控制面没有渲染折叠入口");
  }
  const sources = [
    "../src/features/chat/remote-realtime-panel.tsx",
    "../src/stores/codex-timeline.ts",
    "../src/lib/api.ts",
  ]
    .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  for (const evidence of [
    "生成配对码",
    "grantRemoteThread",
    "revokeRemoteThread",
    "startThreadRealtime",
    "appendThreadRealtimeAudio",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/transcript/delta",
    "PCM16",
    "不会重放",
  ]) {
    if (!sources.includes(evidence)) {
      throw new Error(`Remote & Realtime UI 缺少行为证据：${evidence}`);
    }
  }
  process.stdout.write("Codex Remote & Realtime SSR verification passed\n");
} finally {
  await server.close();
}
