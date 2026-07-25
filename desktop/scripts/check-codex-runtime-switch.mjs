import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "..");
const read = (relative) =>
  fs.readFileSync(path.resolve(repo, relative), "utf8");

const api = read("desktop/src/lib/api.ts");
const store = read("desktop/src/stores/chat.ts");
const timeline = read("desktop/src/features/chat/codex-timeline.tsx");
const tauri = read("desktop/src-tauri/src/lib.rs");
const chat = read("desktop/src-tauri/src/commands/chat.rs");
const loop = read("desktop/src-tauri/src/agent/loop_.rs");

for (const [name, source] of [
  ["frontend API", api],
  ["Tauri command registry", tauri],
  ["legacy chat command", chat],
  ["legacy agent loop", loop],
]) {
  assert.equal(
    source.includes("chat_stream"),
    false,
    `${name} still exposes the retired Workspace chat_stream path`,
  );
  assert.equal(
    source.includes("run_agent_loop"),
    false,
    `${name} still exposes the retired run_agent_loop path`,
  );
}

assert.match(api, /codex_v2_request/);
assert.match(api, /codex_v2_notify/);
assert.match(api, /method:\s*"initialize"/);
assert.match(api, /method:\s*"initialized"/);
assert.match(api, /thread\/resume/);
assert.match(api, /turn\/start/);
assert.match(api, /turn\/interrupt/);
assert.match(store, /codexStartWorkspaceThread/);
assert.match(store, /codexResumeWorkspaceThread/);
assert.match(timeline, /CodexApprovalPrompt/);
assert.match(timeline, /codexV2ServerResponse/);

assert.match(loop, /run_companion_loop/);
assert.match(
  chat,
  /run_companion_loop/,
  "the separate Tietiezhi companion path must remain explicit",
);

console.log(
  "Codex runtime switch: Workspace uses initialize + Thread/Turn/Item; only the companion keeps its isolated legacy loop.",
);
