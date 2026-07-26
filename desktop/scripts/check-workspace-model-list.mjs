import fs from "node:fs";

const chatPage = fs.readFileSync(
  new URL("../src/features/chat/chat-page.tsx", import.meta.url),
  "utf8",
);
const modelSelect = fs.readFileSync(
  new URL("../src/features/chat/model-select.tsx", import.meta.url),
  "utf8",
);
const capabilities = fs.readFileSync(
  new URL("../src/lib/model-capabilities.ts", import.meta.url),
  "utf8",
);
const codexRuntime = fs.readFileSync(
  new URL("../src-tauri/src/commands/codex.rs", import.meta.url),
  "utf8",
);

for (const [name, source] of [
  ["ChatPage", chatPage],
  ["ModelSelect", modelSelect],
]) {
  if (!source.includes("effectiveModelKind(") || !source.includes('=== "chat"')) {
    throw new Error(`${name} 未按渠道模型能力展示全部聊天模型`);
  }
  if (source.includes("agentOnly") || source.includes("isWorkspaceAgentModel")) {
    throw new Error(`${name} 仍在使用固定 Codex 模型白名单`);
  }
}

if (capabilities.includes("CODEX_BUILTIN_AGENT_MODELS")) {
  throw new Error("模型能力层仍包含固定 Codex 模型白名单");
}
if (codexRuntime.includes("workspace_response_model")) {
  throw new Error("Workspace Runtime 仍会偷偷替换用户选择的模型");
}

process.stdout.write("workspace full chat model list verification passed\n");
