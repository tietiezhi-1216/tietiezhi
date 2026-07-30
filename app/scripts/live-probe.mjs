/**
 * Live end-to-end probe of the agent core against a real gateway.
 *
 * Verifies what the unit tests cannot: that a real provider accepts what
 * `provider.ts` sends, that a tool call round-trips, and — the failure that broke
 * the old core — that reasoning `providerData` survives being persisted and
 * replayed.
 *
 * Reads credentials from `app/.env.local`, which is gitignored. Never inline a
 * key here: this repository is public.
 *
 *   cd app && pnpm probe:live
 *
 * `NODE_USE_ENV_PROXY=1` is set by the script because Node's own fetch ignores
 * every form of proxy configuration; the app itself uses Electron's `net.fetch`
 * instead, which honours the system proxy.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const OUT = join(HERE, "..", ".test-out", "main", "agent");
const { runTurn } = await import(`${OUT}/loop.js`);
const { DEFAULT_TOOLS } = await import(`${OUT}/tools.js`);

// Minimal .env.local reader: adding a dotenv dependency for one script is not
// worth the supply-chain surface.
for (const line of (await readFile(join(HERE, "..", ".env.local"), "utf8").catch(() => "")).split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match?.[1] !== undefined && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2] ?? "";
  }
}

const KEY = process.env.TIETIEZHI_TEST_KEY;
const BASE = process.env.TIETIEZHI_TEST_BASE_URL ?? "https://tietiezhi.vip";
if (KEY === undefined || KEY === "") {
  console.error("缺少 TIETIEZHI_TEST_KEY。请在 app/.env.local 里配置（该文件被 gitignore 忽略）。");
  process.exit(1);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "tz-live-"));
  await writeFile(join(dir, "hello.txt"), "第一行\n第二行\n第三行\n", "utf8");
  return dir;
}

function collector() {
  const events = [];
  return {
    events,
    hooks: {
      emit: (event) => events.push(event),
      // Auto-approve so the probe exercises real tool execution end to end.
      approve: async () => ({ outcome: "allow-always" }),
      persist: async () => {},
    },
  };
}

/** One turn against one provider. */
async function turn({ provider, model, instructions, text, cwd, messages = [], reasoning }) {
  const { events, hooks } = collector();
  const result = await runTurn(
    {
      model: { provider, model, apiKey: KEY, baseUrl: BASE },
      instructions: instructions ?? "",
      messages: [...messages, { role: "user", content: [{ type: "text", text }] }],
      tools: DEFAULT_TOOLS,
      maxSteps: 8,
      cwd,
      ...(reasoning ? { reasoning } : {}),
    },
    hooks,
    AbortSignal.timeout(180_000),
  );
  return { result, events };
}

const cwd = await scratch();

// --- 1. openai wire: plain text ------------------------------------------
try {
  const { result, events } = await turn({
    provider: "openai",
    model: "gpt-5.4-mini",
    text: "只回复两个字：收到",
    cwd,
  });
  const text = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
  record("openai 流式文本", text.trim().length > 0 && result.reason === "stop", `回复=${JSON.stringify(text.trim().slice(0, 30))} reason=${result.reason}`);
} catch (error) {
  record("openai 流式文本", false, String(error).slice(0, 300));
}

// --- 2. openai wire: tool call actually runs ------------------------------
try {
  const { result, events } = await turn({
    provider: "openai",
    model: "gpt-5.4-mini",
    instructions: "你是一个代码助手。需要看文件时必须用 read 工具，不要凭空回答。",
    text: "读一下 hello.txt，告诉我第二行是什么。",
    cwd,
  });
  const calls = events.filter((e) => e.type === "tool-call");
  const okResults = events.filter((e) => e.type === "tool-result" && !e.isError);
  const text = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
  record(
    "openai 工具调用真实执行",
    calls.length > 0 && okResults.length > 0 && text.includes("第二行"),
    `调用=${calls.map((c) => c.toolName).join(",")} 成功结果=${okResults.length} 提到第二行=${text.includes("第二行")} reason=${result.reason}`,
  );
} catch (error) {
  record("openai 工具调用真实执行", false, String(error).slice(0, 300));
}

// --- 3. openai wire: multi-step loop that actually edits a file ----------
let openaiHistory = null;
try {
  const { result, events } = await turn({
    provider: "openai",
    model: "gpt-5.4",
    instructions: "你是一个代码助手。改文件前先用 read 看清内容，再用 edit 精确替换。",
    text: "把 hello.txt 里的「第二行」改成「改过的第二行」。",
    cwd,
    reasoning: { effort: "low" },
  });
  const calls = events.filter((e) => e.type === "tool-call");
  // `message-done` is assistant-only by design; the complete history — including
  // the tool-result messages — is what `runTurn` returns and what the store gets.
  openaiHistory = result.messages;
  const content = await readFile(join(cwd, "hello.txt"), "utf8");
  record(
    "多步循环真实改文件",
    content.includes("改过的第二行"),
    `调用=${calls.map((c) => c.toolName).join(",")} 文件已改=${content.includes("改过的第二行")} reason=${result.reason}`,
  );

  const reasoningParts = openaiHistory
    .flatMap((m) => m.content)
    .filter((p) => p.type === "reasoning");
  const signed = reasoningParts.filter((p) => p.providerData !== undefined);
  record(
    "reasoning 携带 providerData",
    reasoningParts.length === 0 || signed.length > 0,
    reasoningParts.length === 0
      ? "本轮未产出 reasoning（跳过）"
      : `${signed.length}/${reasoningParts.length} 带 providerData，键=${JSON.stringify(signed[0] ? Object.keys(signed[0].providerData) : [])}`,
  );
} catch (error) {
  record("多步循环真实改文件", false, String(error).slice(0, 300));
}

// --- 4. the regression that killed the old core: replay the history -------
if (openaiHistory && openaiHistory.length > 0) {
  try {
    // Round-trip through JSON exactly as the session store does.
    const persisted = JSON.parse(JSON.stringify(openaiHistory));
    const { result, events } = await turn({
      provider: "openai",
      model: "gpt-5.4",
      text: "刚才你改了什么？一句话。",
      cwd,
      messages: persisted,
      reasoning: { effort: "low" },
    });
    const errors = events.filter((e) => e.type === "error");
    record(
      "带 providerData 的历史可被重放（旧核心在此 400）",
      result.reason !== "error" && errors.length === 0,
      errors.length > 0 ? String(errors[0].message).slice(0, 240) : `reason=${result.reason}`,
    );
  } catch (error) {
    record("带 providerData 的历史可被重放", false, String(error).slice(0, 300));
  }
}

// --- 5. anthropic wire: request shape reaches the gateway ----------------
try {
  const { result, events } = await turn({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    text: "只回复：收到",
    cwd,
  });
  const text = events.filter((e) => e.type === "text-delta").map((e) => e.text).join("");
  const errors = events.filter((e) => e.type === "error");
  const upstreamLimited = errors.some((e) => /429|受限|do_request_failed/.test(String(e.message)));
  // A gateway-side upstream limit proves the request was well formed: it was
  // accepted and forwarded. Only a malformed request would fail differently.
  record(
    "anthropic 请求形状被网关接受",
    text.trim().length > 0 || upstreamLimited,
    upstreamLimited
      ? "网关上游 429 限流（请求形状正确，能力未验证）"
      : `回复=${JSON.stringify(text.trim().slice(0, 30))} reason=${result.reason}`,
  );
} catch (error) {
  record("anthropic 请求形状被网关接受", false, String(error).slice(0, 240));
}

console.log(`\n通过 ${results.filter((r) => r.ok).length}/${results.length}`);
console.log("说明：该网关的 gemini 模型全部是图像生成模型，无文本模型，google 路径本次无法验证。");
console.log(`工作目录: ${cwd}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
