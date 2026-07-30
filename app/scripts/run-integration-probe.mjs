/**
 * Launches Electron with the integration probe attached.
 *
 * A wrapper rather than a plain npm script because the probe needs a throwaway
 * data directory (it writes a provider and a key) and because Electron's stdout
 * has to be read rather than inherited to survive on macOS.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;

for (const line of (await readFile(join(HERE, "..", ".env.local"), "utf8").catch(() => "")).split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match?.[1] !== undefined && process.env[match[1]] === undefined) {
    process.env[match[1]] = match[2] ?? "";
  }
}

const dataDir = await mkdtemp(join(tmpdir(), "tz-profile-"));
const electron = (await import("electron")).default;

const child = spawn(electron, [join(HERE, "..")], {
  env: {
    ...process.env,
    TIETIEZHI_DATA_DIR: dataDir,
    TIETIEZHI_PROBE_SCRIPT: join(HERE, "integration-probe.mjs"),
    // Node's fetch ignores proxies; the app injects Electron's net.fetch, but the
    // probe also exercises host modules that use plain fetch.
    NODE_USE_ENV_PROXY: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk;
  for (const line of String(chunk).split("\n")) {
    if (line.startsWith("PROBE ")) console.log(line.slice(6));
  }
});
child.stderr.on("data", (chunk) => { out += chunk; });

// A hung turn must not hang the script: without a cap a single stalled request
// keeps Electron alive forever and the run reports nothing at all.
const CAP_MS = Number(process.env.TIETIEZHI_PROBE_TIMEOUT_MS ?? 240000);
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    console.log(`探针超过 ${CAP_MS}ms 未结束，已终止`);
    child.kill("SIGKILL");
    resolve(1);
  }, CAP_MS);
  child.on("exit", (value) => { clearTimeout(timer); resolve(value); });
});
if (!out.includes("PROBE 通过")) {
  console.log("探针未产出结果，Electron 输出：");
  console.log(out.split("\n").filter((l) => !l.startsWith("PROBE ")).slice(-25).join("\n"));
}
console.log(`临时档案目录 ${dataDir}`);
process.exit(code ?? 1);
