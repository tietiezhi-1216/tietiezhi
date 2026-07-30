/**
 * Full-stack integration probe: the path the app actually takes.
 *
 * `probe:live` drives the agent core directly, which leaves the last link
 * unverified — settings lookup, the encrypted key vault, `wiring.ts`'s provider
 * mapping, and dispatch through the bridge. This runs inside the real main
 * process and calls the real command handlers, so a break in any of those shows
 * up here instead of in front of the user.
 *
 *   cd app && pnpm probe:integration
 *
 * Loaded by `src/main/index.ts` when `TIETIEZHI_PROBE_SCRIPT` is set. Point
 * `TIETIEZHI_DATA_DIR` at a temporary directory — this writes a provider and a
 * key, and must never touch the real profile.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  // Written straight to stdout with a marker: Electron's console output is not
  // reliably flushed through a pipe on macOS, so the caller greps for this.
  process.stdout.write(`PROBE ${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

/** Waits for a turn's events, since `agent_prompt` resolves only at the end. */
function collectEvents() {
  const events = [];
  return { events, push: (event) => events.push(event) };
}

export default async function run({ dispatchCommand, seedGatewayKey, setApprovalPolicy }) {
  // No renderer exists here, so nobody can answer an approval prompt. Without a
  // policy the mutating tools would be refused and the probe would prove nothing.
  setApprovalPolicy(() => ({ outcome: "allow-always" }));
  const KEY = process.env.TIETIEZHI_TEST_KEY;
  const BASE = process.env.TIETIEZHI_TEST_BASE_URL ?? "https://tietiezhi.vip";
  const MODEL = process.env.TIETIEZHI_TEST_MODEL ?? "gpt-5.4-mini";
  if (!KEY) {
    process.stdout.write("PROBE ✖ 缺少 TIETIEZHI_TEST_KEY（见 app/.env.local）\n");
    return false;
  }

  const cwd = await mkdtemp(join(tmpdir(), "tz-integ-"));
  await writeFile(join(cwd, "notes.txt"), "alpha\nbravo\ncharlie\n", "utf8");

  // --- 1. configure a provider the way the settings UI would ---------------
  try {
    const settings = await dispatchCommand("load_settings", {}, null);
    settings.providers = [
      {
        id: "builtin-official",
        name: "Tietiezhi Gateway",
        type: "openai",
        baseUrl: BASE,
        builtIn: true,
        models: [{ id: MODEL }],
      },
    ];
    settings.chatProviderId = "builtin-official";
    settings.chatModel = MODEL;
    await dispatchCommand("save_settings", { settings }, null);

    // `tietiezhi.vip` is the product's built-in gateway: settings coerce any
    // provider at that host to `builtIn`, and a built-in provider reads a
    // gateway-issued key rather than a pasted one. Seeding the vault the way
    // login does is what makes an already-issued key usable here.
    const saved = await dispatchCommand("load_settings", {}, null);
    const builtin = saved.providers.find((p) => p.builtIn === true);
    await seedGatewayKey(builtin?.id ?? "builtin-official", BASE, KEY);

    // `hasKey` reflects only a pasted provider key; a gateway-issued key lives
    // under different vault accounts, so the real check is that a turn works.
    const providers = await dispatchCommand("list_providers", {}, null);
    const entry = providers.find((p) => p.builtIn === true);
    record("内置供应商已配置", entry !== undefined && entry.baseUrl === BASE, `baseUrl=${entry?.baseUrl}`);
  } catch (error) {
    record("供应商与密钥写入成功", false, String(error).slice(0, 220));
    return false;
  }

  // --- 2. the wiring layer resolves that provider -------------------------
  let sessionId = null;
  try {
    const meta = await dispatchCommand("agent_session_new", { cwd, provider: "openai", model: MODEL }, null);
    sessionId = meta.id;
    record("会话创建成功", typeof meta.id === "string" && meta.cwd === cwd, `id=${meta.id?.slice(0, 8)}…`);
  } catch (error) {
    record("会话创建成功", false, String(error).slice(0, 220));
    return false;
  }

  // --- 3. a real turn through the real handler ----------------------------
  try {
    const outcome = await dispatchCommand(
      "agent_prompt",
      {
        sessionId,
        text: "读一下 notes.txt，然后用 edit 把 bravo 改成 BRAVO。",
        instructions: "你是代码助手。改文件前先 read 看清内容，再用 edit 精确替换。",
        maxSteps: 6,
      },
      null,
    );
    const content = await readFile(join(cwd, "notes.txt"), "utf8");
    record(
      "整条链路跑通并真实改文件",
      content.includes("BRAVO") && outcome.reason === "stop",
      `reason=${outcome.reason} 文件已改=${content.includes("BRAVO")} tokens=${outcome.usage?.totalTokens ?? "?"}`,
    );
  } catch (error) {
    record("整条链路跑通并真实改文件", false, String(error).slice(0, 260));
  }

  // --- 4. history survives a reload ---------------------------------------
  try {
    const loaded = await dispatchCommand("agent_session_load", { sessionId }, null);
    const hasToolCall = loaded.messages.some((m) => m.content.some((p) => p.type === "tool-call"));
    const hasToolResult = loaded.messages.some((m) => m.content.some((p) => p.type === "tool-result"));
    record(
      "历史落盘且工具调用与结果都在",
      loaded.messages.length > 0 && hasToolCall && hasToolResult,
      `消息=${loaded.messages.length} 工具调用=${hasToolCall} 工具结果=${hasToolResult}`,
    );
  } catch (error) {
    record("历史落盘且工具调用与结果都在", false, String(error).slice(0, 220));
  }

  // --- 5. a second turn replays the persisted history ---------------------
  try {
    const outcome = await dispatchCommand(
      "agent_prompt",
      { sessionId, text: "刚才你改了什么？一句话。", maxSteps: 3 },
      null,
    );
    record("重放持久化历史继续对话", outcome.reason === "stop", `reason=${outcome.reason}`);
  } catch (error) {
    record("重放持久化历史继续对话", false, String(error).slice(0, 260));
  }

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`PROBE 通过 ${passed}/${results.length}\nPROBE 工作目录 ${cwd}\n`);
  return passed === results.length;
}

export { collectEvents };
