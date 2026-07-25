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
  const { RuntimeDiagnosticsSection } = await server.ssrLoadModule(
    "/src/features/settings/runtime-diagnostics-section.tsx",
  );
  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(RuntimeDiagnosticsSection),
    ),
  );
  for (const label of [
    "Codex Runtime Doctor",
    "运行指标",
    "提交诊断反馈",
    "重新检查",
  ]) {
    if (!html.includes(label)) {
      throw new Error(`运行诊断界面缺少内容：${label}`);
    }
  }
  const sources = [
    "../src/features/settings/runtime-diagnostics-section.tsx",
    "../src/features/settings/settings-dialog.tsx",
    "../src/lib/api.ts",
  ]
    .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  for (const evidence of [
    "codexDoctorReport",
    "codexRuntimeMetrics",
    "codexExportTelemetry",
    "feedback/upload",
    "includeLogs: true",
    "diagnostics",
  ]) {
    if (!sources.includes(evidence)) {
      throw new Error(`运行诊断 UI 缺少行为证据：${evidence}`);
    }
  }
  process.stdout.write("Codex Runtime diagnostics SSR verification passed\n");
} finally {
  await server.close();
}
