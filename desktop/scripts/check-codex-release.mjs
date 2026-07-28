import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(desktop, "..");
// Windows runners check out with CRLF; normalize so `\n` matching works.
const read = (relative) =>
  fs.readFileSync(path.join(repo, relative), "utf8").replaceAll("\r\n", "\n");
const json = (relative) => JSON.parse(read(relative));

const baseline = json("shared/codex/v2/upstream-baseline.json");
assert.equal(baseline.tag, "rust-v0.145.0");
assert.equal(
  baseline.commit,
  "25af12f7e61572b0bc18ddb1008be543b91519b0",
);
assert.deepEqual(
  baseline.milestones
    .filter((milestone) => milestone.status !== "completed")
    .map((milestone) => milestone.id),
  [],
  "every R0-R39 milestone must be completed before release",
);
for (const [surface, entries] of Object.entries(baseline.surfaces)) {
  const incomplete = entries
    .filter(
      (entry) =>
        entry.status !== "implemented" && entry.status !== "service_mapped",
    )
    .map((entry) => entry.method);
  assert.deepEqual(incomplete, [], `${surface} contains incomplete methods`);
}

const packageDocument = json("desktop/package.json");
const tauri = json("desktop/src-tauri/tauri.conf.json");
const cargo = read("desktop/src-tauri/Cargo.toml");
const cargoLock = read("desktop/src-tauri/Cargo.lock");
const cargoVersion = cargo.match(
  /\[package\][\s\S]*?\nversion = "([^"]+)"/,
)?.[1];
const lockVersion = cargoLock.match(
  /\[\[package\]\]\nname = "tietiezhi-desktop"\nversion = "([^"]+)"/,
)?.[1];
assert.ok(cargoVersion, "desktop Cargo.toml package version is missing");
assert.equal(packageDocument.version, tauri.version);
assert.equal(packageDocument.version, cargoVersion);
assert.equal(packageDocument.version, lockVersion);
assert.match(packageDocument.version, /^\d{4}\.\d{1,2}\.\d{1,2}-t\d{6}$/);
if (process.env.RELEASE_TAG) {
  assert.equal(process.env.RELEASE_TAG, `v${packageDocument.version}`);
}

const csp = tauri.app?.security?.csp;
assert.equal(typeof csp, "string", "release CSP must not be disabled");
for (const directive of [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]) {
  assert.ok(csp.includes(directive), `release CSP is missing: ${directive}`);
}
assert.deepEqual(tauri.app.security.assetProtocol.scope, [
  "$APPDATA/create-assets/**/*",
]);
assert.equal(tauri.bundle.createUpdaterArtifacts, true);
assert.match(tauri.plugins.updater.endpoints[0], /^https:\/\/github\.com\//);
assert.ok(tauri.plugins.updater.pubkey.length > 80);

const api = read("desktop/src/lib/api.ts");
const tauriLib = read("desktop/src-tauri/src/lib.rs");
const legacyLoop = read("desktop/src-tauri/src/agent/loop_.rs");
for (const source of [api, tauriLib, legacyLoop]) {
  assert.equal(source.includes("chat_stream"), false);
  assert.equal(source.includes("run_agent_loop"), false);
}
assert.match(api, /method:\s*"initialize"/);
assert.match(api, /method:\s*"initialized"/);

const release = read(".github/workflows/release.yml");
for (const required of [
  "platform: macos",
  "platform: windows",
  "universal-apple-darwin",
  "x86_64-pc-windows-msvc",
  "TAURI_SIGNING_PRIVATE_KEY",
  "Notarize and staple DMG",
  "updater-latest.json",
  "if-no-files-found: error",
  "pnpm test:codex-release",
  "pnpm audit --audit-level low",
  "cargo audit --file src-tauri/Cargo.lock",
]) {
  assert.ok(release.includes(required), `release workflow is missing: ${required}`);
}

for (const required of [
  "docs/CODEX-MIGRATION.md",
  "docs/CODEX-RELEASE.md",
  "THIRD_PARTY_NOTICES.md",
]) {
  assert.ok(fs.existsSync(path.join(repo, required)), `${required} is missing`);
}

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: repo,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const forbiddenFiles = tracked.filter((file) =>
  /(^|\/)(\.env(?:\.|$)|id_rsa$)|\.(?:p12|pfx|pem|key)$/i.test(file),
);
assert.deepEqual(forbiddenFiles, [], "tracked secret-bearing file names found");

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];
const secretMatches = [];
for (const file of tracked) {
  const absolute = path.join(repo, file);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 1_000_000) continue;
  const contents = fs.readFileSync(absolute, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(contents))) {
    secretMatches.push(file);
  }
}
assert.deepEqual(secretMatches, [], "tracked high-confidence secret detected");

console.log(
  `Codex GA release gate OK: ${baseline.milestones.length} milestones, ` +
    `${Object.values(baseline.surfaces).flat().length} methods, version ${packageDocument.version}`,
);
