#!/usr/bin/env node
/**
 * End-to-end verification of the host's ACP client path against a *real*
 * external core.
 *
 * Deliberately standalone: it imports `@agentclientprotocol/sdk` and Node
 * built-ins only, never Electron. The point is to prove the protocol layer
 * works outside the app shell, so a failure here can never be blamed on
 * Electron packaging, and so the script can run in CI where no display exists.
 *
 * The stream bridging, the client capability set (no `fs`, no `terminal`) and
 * the permission handling below mirror `src/main/acp/connection.ts` on
 * purpose. If they drift, this script stops proving anything about the host.
 *
 * Usage:
 *   node scripts/verify-acp.mjs --core codex-acp
 *   node scripts/verify-acp.mjs --command /path/to/agent --arg --acp
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from "@agentclientprotocol/sdk";

const SCRIPT_DIR = import.meta.dirname;
const APP_DIR = dirname(SCRIPT_DIR);
const VERIFY_DIR = join(APP_DIR, ".verify");

/** JSON-RPC code the ACP spec reserves for "you must authenticate first". */
const AUTH_REQUIRED = -32000;
/** JSON-RPC "method not found", reused for capabilities we never declared. */
const METHOD_NOT_FOUND = -32601;

/**
 * Cores this script knows how to launch. `bin` is looked up in
 * `.verify/node_modules/.bin` first, then on PATH, so an operator can point at
 * a globally installed CLI without reinstalling.
 */
const CORE_PRESETS = {
  "codex-acp": {
    label: "@agentclientprotocol/codex-acp",
    packageName: "@agentclientprotocol/codex-acp",
    bin: "codex-acp",
    args: [],
  },
  "claude-code-acp": {
    label: "@zed-industries/claude-code-acp (deprecated)",
    packageName: "@zed-industries/claude-code-acp",
    bin: "claude-code-acp",
    args: [],
  },
  "claude-agent-acp": {
    label: "@agentclientprotocol/claude-agent-acp",
    packageName: "@agentclientprotocol/claude-agent-acp",
    bin: "claude-agent-acp",
    args: [],
  },
  gemini: {
    label: "@google/gemini-cli (--acp)",
    packageName: "@google/gemini-cli",
    bin: "gemini",
    args: ["--acp"],
  },
};

/**
 * Environment passed to the core, built as an allowlist rather than a
 * denylist. A denylist silently leaks whatever key name we failed to think of;
 * this verification must be able to state truthfully that no credential from
 * the operator's shell reached the core.
 */
const ENV_ALLOWLIST = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "USER",
  "SHELL",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/** Names that look credential-bearing, reported (names only) as "withheld". */
const SECRET_NAME_PATTERN = /(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY$)/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

class StepTimeoutError extends Error {
  constructor(label, ms) {
    super(`步骤「${label}」超过 ${ms}ms 未返回，判定为超时。`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Races a promise against a deadline. Used on every protocol step: a core that
 * hangs must produce a report, not an infinite wait.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new StepTimeoutError(label, ms)), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Turns any thrown value into something JSON-serialisable and readable. */
function describeError(error) {
  if (error instanceof RequestError) {
    return {
      type: "RequestError",
      code: error.code,
      message: error.message,
      data: error.data ?? null,
    };
  }
  if (error instanceof Error) {
    const out = { type: error.name, message: error.message };
    // ACP RequestErrors sometimes arrive as plain objects after transport.
    if (typeof error.code === "number") out.code = error.code;
    if (error.data !== undefined) out.data = error.data;
    if (error.stack) out.stack = error.stack;
    return out;
  }
  return { type: "unknown", message: String(error) };
}

function isAuthError(error) {
  const described = describeError(error);
  if (described.code === AUTH_REQUIRED) return true;
  return /auth|login|api[_ -]?key|credential|not logged in|unauthor/i.test(described.message ?? "");
}

// ---------------------------------------------------------------------------
// Node stream <-> Web stream bridging (mirrors src/main/acp/connection.ts)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return textEncoder.encode(chunk);
  return textEncoder.encode(String(chunk));
}

/**
 * Splits a byte stream into complete lines for the wire log. The log is the
 * evidence this whole report rests on, so it records what actually crossed the
 * pipe, before any SDK parsing or validation could reshape it.
 */
function makeLineTap(onLine) {
  let buffer = "";
  return (bytes) => {
    buffer += Buffer.from(bytes).toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) onLine(line);
      index = buffer.indexOf("\n");
    }
  };
}

function toWebReadable(source, onBytes) {
  return new ReadableStream({
    start(controller) {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true;
        if (error) controller.error(error);
        else controller.close();
      };
      source.on("data", (chunk) => {
        const bytes = toBytes(chunk);
        onBytes(bytes);
        controller.enqueue(bytes);
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.once("end", () => finish());
      source.once("close", () => finish());
      source.once("error", (error) => finish(error));
    },
    pull() {
      source.resume();
    },
    cancel() {
      source.destroy();
    },
  });
}

function toWebWritable(sink, onBytes) {
  return new WritableStream({
    write(chunk) {
      onBytes(toBytes(chunk));
      return new Promise((resolvePromise, reject) => {
        sink.write(chunk, (error) => (error ? reject(error) : resolvePromise()));
      });
    },
    close() {
      return new Promise((resolvePromise) => {
        sink.end(() => resolvePromise());
      });
    },
    abort() {
      sink.destroy();
    },
  });
}

// ---------------------------------------------------------------------------
// Static cross-check: what does normalize.ts actually handle?
// ---------------------------------------------------------------------------

/**
 * Extracts the `case "..."` labels from `normalizeSessionUpdate`. Parsed from
 * source rather than hard-coded so this script cannot drift into claiming
 * coverage the host no longer has.
 */
function readNormalizeCoverage() {
  const path = join(APP_DIR, "src", "main", "acp", "normalize.ts");
  if (!existsSync(path)) return { path, available: false, handled: [] };
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("export function normalizeSessionUpdate");
  if (start < 0) return { path, available: false, handled: [] };
  const body = source.slice(start);
  const handled = new Set();
  for (const match of body.matchAll(/case\s+"([a-zA-Z_]+)"/g)) {
    if (match[1]) handled.add(match[1]);
  }
  return { path, available: true, handled: [...handled].sort() };
}

/** Every `sessionUpdate` discriminator the pinned SDK schema knows about. */
function readSdkVariants() {
  const path = join(
    APP_DIR,
    "node_modules",
    "@agentclientprotocol",
    "sdk",
    "dist",
    "schema",
    "types.gen.d.ts",
  );
  if (!existsSync(path)) return { path, available: false, variants: [] };
  const source = readFileSync(path, "utf8");
  const variants = new Set();
  for (const match of source.matchAll(/sessionUpdate:\s*"([a-z_]+)"/g)) {
    if (match[1]) variants.add(match[1]);
  }
  return { path, available: true, variants: [...variants].sort() };
}

function readInstalledVersion(packageName) {
  const path = join(VERIFY_DIR, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core launch
// ---------------------------------------------------------------------------

function resolveCommand(preset, override) {
  if (override) return { command: override, resolvedFrom: "--command" };
  const local = join(VERIFY_DIR, "node_modules", ".bin", preset.bin);
  if (existsSync(local)) return { command: local, resolvedFrom: ".verify/node_modules/.bin" };
  return { command: preset.bin, resolvedFrom: "PATH" };
}

/**
 * Builds the child environment and reports what was withheld.
 *
 * HOME is redirected into `.verify/home` unless the operator opts out: cores
 * keep OAuth sessions under the real HOME, and silently reusing the operator's
 * logged-in account would make an unauthenticated run look authenticated and
 * invalidate the whole result.
 */
function buildChildEnv(useHostHome) {
  const env = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }

  const withheld = [];
  for (const name of Object.keys(process.env)) {
    if (ENV_ALLOWLIST.includes(name)) continue;
    if (SECRET_NAME_PATTERN.test(name)) withheld.push(name);
  }
  withheld.sort();

  let home;
  if (useHostHome) {
    home = process.env.HOME ?? "";
    if (home) env.HOME = home;
  } else {
    home = join(VERIFY_DIR, "home");
    mkdirSync(home, { recursive: true });
    env.HOME = home;
    // Some CLIs read XDG paths independently of HOME.
    env.XDG_CONFIG_HOME = join(home, ".config");
    env.XDG_DATA_HOME = join(home, ".local", "share");
    env.XDG_CACHE_HOME = join(home, ".cache");
  }

  return { env, withheld, home, isolatedHome: !useHostHome };
}

// ---------------------------------------------------------------------------
// The verification run
// ---------------------------------------------------------------------------

async function runVerification(options) {
  const report = {
    startedAt: new Date().toISOString(),
    host: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    clientProtocolVersion: PROTOCOL_VERSION,
    core: {
      id: options.coreId,
      label: options.preset?.label ?? "custom",
      packageName: options.preset?.packageName ?? null,
      installedVersion: options.preset ? readInstalledVersion(options.preset.packageName) : null,
      command: options.command,
      args: options.args,
      resolvedFrom: options.resolvedFrom,
    },
    env: {
      isolatedHome: options.envInfo.isolatedHome,
      home: options.envInfo.home,
      withheldSecretLikeVars: options.envInfo.withheld,
      passedThrough: Object.keys(options.envInfo.env).sort(),
    },
    steps: [],
    initialize: null,
    session: null,
    prompt: null,
    updates: { count: 0, byVariant: {}, samples: {} },
    clientRequests: { requestPermission: 0, refusedCapabilityCalls: [] },
    stderr: [],
    shutdown: null,
    coverage: null,
    verdict: null,
  };

  const steps = report.steps;
  const step = async (name, fn, timeoutMs) => {
    const started = nowMs();
    try {
      const value = await withTimeout(Promise.resolve().then(fn), timeoutMs, name);
      steps.push({ name, ok: true, ms: nowMs() - started });
      return { ok: true, value };
    } catch (error) {
      steps.push({ name, ok: false, ms: nowMs() - started, error: describeError(error) });
      return { ok: false, error };
    }
  };

  // --- spawn ---------------------------------------------------------------
  const wireLog = [];
  const recordWire = (direction) =>
    makeLineTap((line) => {
      wireLog.push({ t: new Date().toISOString(), direction, line });
    });

  let child;
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.envInfo.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    steps.push({ name: "spawn", ok: false, ms: 0, error: describeError(error) });
    report.verdict = { ok: false, reason: `无法启动核心进程：${describeError(error).message}` };
    return { report, wireLog };
  }

  const spawnFailure = new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise(error));
  });

  const exitInfo = { exited: false, code: null, signal: null };
  const exited = new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => {
      exitInfo.exited = true;
      exitInfo.code = code;
      exitInfo.signal = signal;
      resolvePromise();
    });
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim().length > 0 && report.stderr.length < 200) report.stderr.push(line);
    }
  });
  child.stderr?.on("error", () => {});

  if (!child.stdin || !child.stdout) {
    report.verdict = { ok: false, reason: "核心进程没有可用的 stdin/stdout 管道。" };
    return { report, wireLog };
  }

  // --- connect -------------------------------------------------------------
  const noteUpdate = (params) => {
    const variant =
      typeof params?.update?.sessionUpdate === "string" ? params.update.sessionUpdate : "<missing>";
    report.updates.count += 1;
    report.updates.byVariant[variant] = (report.updates.byVariant[variant] ?? 0) + 1;
    // One sample per variant is enough to diff against normalize.ts by hand.
    if (!(variant in report.updates.samples)) {
      report.updates.samples[variant] = params;
    }
  };

  const refuse = (method, capability) => {
    report.clientRequests.refusedCapabilityCalls.push({ method, capability });
    throw new RequestError(
      METHOD_NOT_FOUND,
      `铁铁汁未声明 "${capability}" 客户端能力，${method} 不可用。核心应使用自身的文件系统与终端。`,
    );
  };

  const client = {
    requestPermission(params) {
      report.clientRequests.requestPermission += 1;
      // Always decline: an unattended verification must never approve a real
      // side effect on the operator's machine.
      const cancel = { outcome: { outcome: "cancelled" } };
      if (!Array.isArray(params?.options)) return cancel;
      const reject = params.options.find(
        (option) => option.kind === "reject_once" || option.kind === "reject_always",
      );
      if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
      return cancel;
    },
    sessionUpdate(params) {
      noteUpdate(params);
    },
    readTextFile: () => refuse("fs/read_text_file", "fs.readTextFile"),
    writeTextFile: () => refuse("fs/write_text_file", "fs.writeTextFile"),
    createTerminal: () => refuse("terminal/create", "terminal"),
    terminalOutput: () => refuse("terminal/output", "terminal"),
    releaseTerminal: () => refuse("terminal/release", "terminal"),
    waitForTerminalExit: () => refuse("terminal/wait_for_exit", "terminal"),
    killTerminal: () => refuse("terminal/kill", "terminal"),
  };

  const stream = ndJsonStream(
    toWebWritable(child.stdin, recordWire("out")),
    toWebReadable(child.stdout, recordWire("in")),
  );
  const connection = new ClientSideConnection(() => client, stream);

  // --- initialize ----------------------------------------------------------
  const initStep = await step(
    "initialize",
    () =>
      Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          // Same stance as the host: no fs, no terminal.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "tietiezhi-verify-acp", version: "0.1.0" },
        }),
        spawnFailure.then((error) => {
          throw error;
        }),
      ]),
    options.timeoutMs,
  );

  if (!initStep.ok) {
    report.verdict = {
      ok: false,
      reason: `initialize 失败：${describeError(initStep.error).message}`,
    };
    await shutdown(child, connection, exited, exitInfo, report, options);
    report.coverage = buildCoverage(report);
    return { report, wireLog };
  }

  const initialized = initStep.value;
  report.initialize = {
    protocolVersion: initialized.protocolVersion,
    agentCapabilities: initialized.agentCapabilities ?? null,
    authMethods: initialized.authMethods ?? [],
    agentInfo: initialized.agentInfo ?? null,
    raw: initialized,
  };

  // --- session/new ---------------------------------------------------------
  const sessionStep = await step(
    "session/new",
    () => connection.newSession({ cwd: options.cwd, mcpServers: [] }),
    options.timeoutMs,
  );

  if (!sessionStep.ok) {
    const described = describeError(sessionStep.error);
    const authRelated = isAuthError(sessionStep.error);
    report.session = { created: false, error: described, recognisedAsAuthError: authRelated };
    report.verdict = authRelated
      ? {
          ok: true,
          degraded: true,
          reason:
            "握手成功；session/new 因缺少凭据被拒，错误被完整捕获并归一。协议层链路通，推理链路未验证。",
        }
      : { ok: false, reason: `session/new 失败且不是认证问题：${described.message}` };
    await shutdown(child, connection, exited, exitInfo, report, options);
    report.coverage = buildCoverage(report);
    return { report, wireLog };
  }

  const sessionId = sessionStep.value.sessionId;
  report.session = { created: true, sessionId, raw: sessionStep.value };

  // --- session/prompt ------------------------------------------------------
  const promptStep = await step(
    "session/prompt",
    () =>
      connection.prompt({
        sessionId,
        prompt: [{ type: "text", text: options.promptText }],
      }),
    options.promptTimeoutMs,
  );

  if (promptStep.ok) {
    report.prompt = {
      ok: true,
      stopReason: promptStep.value.stopReason,
      raw: promptStep.value,
    };
  } else {
    const described = describeError(promptStep.error);
    report.prompt = {
      ok: false,
      error: described,
      recognisedAsAuthError: isAuthError(promptStep.error),
    };
  }

  // Reconstruct what the renderer would have shown, from the updates only.
  report.reconstructedText = reconstructAssistantText(report.updates.samples, report.updates);

  await shutdown(child, connection, exited, exitInfo, report, options);
  report.coverage = buildCoverage(report);

  if (promptStep.ok) {
    report.verdict = {
      ok: true,
      degraded: false,
      reason: `全链路打通：initialize + session/new + session/prompt 完成，stopReason=${report.prompt.stopReason}。`,
    };
  } else if (report.prompt.recognisedAsAuthError) {
    report.verdict = {
      ok: true,
      degraded: true,
      reason: "握手与 session/new 成功；session/prompt 因缺少凭据失败，错误被完整捕获。",
    };
  } else {
    report.verdict = {
      ok: false,
      reason: `session/prompt 失败且不是认证问题：${report.prompt.error.message}`,
    };
  }

  return { report, wireLog };
}

/**
 * Text deltas are accumulated separately from the per-variant samples, because
 * samples keep only the first occurrence of each variant.
 */
function reconstructAssistantText(_samples, updates) {
  return {
    note: "逐条 delta 见 wire 日志；此处只统计数量。",
    messageChunks: updates.byVariant.agent_message_chunk ?? 0,
    thoughtChunks: updates.byVariant.agent_thought_chunk ?? 0,
  };
}

async function shutdown(child, connection, exited, exitInfo, report, options) {
  const started = nowMs();
  let closeError = null;
  try {
    // Signal rather than closing stdin: a core wedged mid-turn never notices EOF.
    child.kill();
    await withTimeout(exited, options.shutdownTimeoutMs, "core exit");
  } catch (error) {
    closeError = describeError(error);
    try {
      child.kill("SIGKILL");
      await withTimeout(exited, 5000, "core SIGKILL");
    } catch {
      // Reported below via exitInfo.exited === false.
    }
  }
  void connection;
  report.shutdown = {
    clean: exitInfo.exited && closeError === null,
    exited: exitInfo.exited,
    code: exitInfo.code,
    signal: exitInfo.signal,
    ms: nowMs() - started,
    error: closeError,
  };
}

/** Diffs what the core actually emitted against what normalize.ts handles. */
function buildCoverage(report) {
  const normalize = readNormalizeCoverage();
  const sdk = readSdkVariants();
  const observed = Object.keys(report.updates.byVariant).sort();
  const handled = new Set(normalize.handled);

  return {
    normalizePath: normalize.path,
    normalizeAvailable: normalize.available,
    normalizeHandles: normalize.handled,
    sdkVariants: sdk.variants,
    sdkKnownButNotHandled: sdk.variants.filter((variant) => !handled.has(variant)),
    observedFromCore: observed,
    observedAndHandled: observed.filter((variant) => handled.has(variant)),
    observedButNotHandled: observed.filter((variant) => !handled.has(variant)),
    observedButUnknownToSdk: sdk.available
      ? observed.filter((variant) => !sdk.variants.includes(variant))
      : [],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  const presets = Object.keys(CORE_PRESETS).join(", ");
  process.stdout.write(
    [
      "用法: node scripts/verify-acp.mjs [选项]",
      "",
      "选项:",
      `  --core <id>            预置核心之一: ${presets} (默认 codex-acp)`,
      "  --command <path>       直接指定可执行文件，覆盖预置",
      "  --arg <value>          追加一个启动参数，可重复",
      "  --cwd <path>           session/new 的工作目录 (默认当前目录)",
      "  --prompt <text>        发送的提示词",
      "  --timeout <ms>         initialize / session-new 单步超时 (默认 120000)",
      "  --prompt-timeout <ms>  session/prompt 超时 (默认 180000)",
      "  --use-host-home        使用真实 HOME (默认隔离到 .verify/home)",
      "  --out-dir <path>       报告输出目录 (默认 .verify)",
      "  --help                 显示此帮助",
      "",
    ].join("\n"),
  );
}

function summarise(report) {
  const lines = [];
  const mark = (ok) => (ok ? "OK  " : "FAIL");
  lines.push("");
  lines.push("=== ACP 端到端验证 ===");
  lines.push(`核心:        ${report.core.label} (${report.core.id})`);
  lines.push(`版本:        ${report.core.installedVersion ?? "未知"}`);
  lines.push(`可执行文件:  ${report.core.command} [${report.core.args.join(" ")}]  <- ${report.core.resolvedFrom}`);
  lines.push(`HOME 隔离:   ${report.env.isolatedHome ? `是 (${report.env.home})` : "否（使用真实 HOME）"}`);
  lines.push(`已屏蔽变量:  ${report.env.withheldSecretLikeVars.length > 0 ? report.env.withheldSecretLikeVars.join(", ") : "（无）"}`);
  lines.push("");
  lines.push("步骤:");
  for (const item of report.steps) {
    lines.push(`  ${mark(item.ok)} ${item.name} (${item.ms}ms)`);
    if (!item.ok) lines.push(`       -> ${item.error.message}`);
  }
  if (report.initialize) {
    lines.push("");
    lines.push(`协商 protocolVersion: ${report.initialize.protocolVersion} (客户端请求 ${report.clientProtocolVersion})`);
    lines.push(`agentCapabilities:    ${JSON.stringify(report.initialize.agentCapabilities)}`);
    lines.push(`authMethods:          ${JSON.stringify(report.initialize.authMethods)}`);
  }
  lines.push("");
  lines.push(`session/update 事件数: ${report.updates.count}`);
  for (const [variant, count] of Object.entries(report.updates.byVariant)) {
    lines.push(`  ${variant}: ${count}`);
  }
  if (report.coverage) {
    lines.push("");
    lines.push(`normalize.ts 覆盖:     ${report.coverage.normalizeHandles.join(", ")}`);
    lines.push(`实际收到且已覆盖:      ${report.coverage.observedAndHandled.join(", ") || "（无）"}`);
    lines.push(`实际收到但未覆盖:      ${report.coverage.observedButNotHandled.join(", ") || "（无）"}`);
    lines.push(`SDK 已知但未覆盖:      ${report.coverage.sdkKnownButNotHandled.join(", ") || "（无）"}`);
  }
  if (report.stderr.length > 0) {
    lines.push("");
    lines.push("核心 stderr (前 20 行):");
    for (const line of report.stderr.slice(0, 20)) lines.push(`  ${line}`);
  }
  if (report.shutdown) {
    lines.push("");
    lines.push(
      `关闭: ${report.shutdown.clean ? "干净" : "不干净"} (code=${report.shutdown.code}, signal=${report.shutdown.signal}, ${report.shutdown.ms}ms)`,
    );
  }
  lines.push("");
  lines.push(`结论: ${report.verdict?.ok ? (report.verdict.degraded ? "降级通过" : "通过") : "失败"}`);
  lines.push(`      ${report.verdict?.reason ?? "（无）"}`);
  lines.push("");
  return lines.join("\n");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        core: { type: "string", default: "codex-acp" },
        command: { type: "string" },
        arg: { type: "string", multiple: true, default: [] },
        cwd: { type: "string" },
        prompt: { type: "string", default: "回复 OK 两个字符，不要有其他内容。" },
        timeout: { type: "string", default: "120000" },
        "prompt-timeout": { type: "string", default: "180000" },
        "use-host-home": { type: "boolean", default: false },
        "out-dir": { type: "string" },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    process.stderr.write(`参数错误: ${error instanceof Error ? error.message : String(error)}\n`);
    printHelp();
    process.exitCode = 2;
    return;
  }

  const values = parsed.values;
  if (values.help) {
    printHelp();
    return;
  }

  const coreId = values.core ?? "codex-acp";
  const preset = CORE_PRESETS[coreId];
  if (!preset && !values.command) {
    process.stderr.write(
      `未知核心 "${coreId}"，且未提供 --command。可用预置: ${Object.keys(CORE_PRESETS).join(", ")}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const resolved = resolveCommand(preset ?? { bin: coreId }, values.command);
  const args = values.arg.length > 0 ? values.arg : (preset?.args ?? []);
  const cwd = resolve(values.cwd ?? process.cwd());
  const envInfo = buildChildEnv(values["use-host-home"] === true);
  const outDir = resolve(values["out-dir"] ?? VERIFY_DIR);
  mkdirSync(outDir, { recursive: true });

  const { report, wireLog } = await runVerification({
    coreId,
    preset,
    command: resolved.command,
    resolvedFrom: resolved.resolvedFrom,
    args,
    cwd,
    envInfo,
    promptText: values.prompt ?? "回复 OK 两个字符，不要有其他内容。",
    timeoutMs: Number(values.timeout) || 120_000,
    promptTimeoutMs: Number(values["prompt-timeout"]) || 180_000,
    shutdownTimeoutMs: 10_000,
  });

  report.finishedAt = new Date().toISOString();

  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const reportPath = join(outDir, `report-${coreId}-${stamp}.json`);
  const wirePath = join(outDir, `wire-${coreId}-${stamp}.ndjson`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(wirePath, wireLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

  process.stdout.write(summarise(report));
  process.stdout.write(`报告: ${reportPath}\n原始报文: ${wirePath}\n\n`);

  process.exitCode = report.verdict?.ok ? 0 : 1;
}

await main();
