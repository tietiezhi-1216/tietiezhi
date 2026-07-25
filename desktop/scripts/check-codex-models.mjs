import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const baselinePath = path.join(
  repoRoot,
  "shared/codex/v2/model-baseline.json",
);
const upstreamBaselinePath = path.join(
  repoRoot,
  "shared/codex/v2/upstream-baseline.json",
);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(`Codex model baseline check failed: ${message}`);
};

const baseline = readJson(baselinePath);
const upstream = readJson(upstreamBaselinePath);
const projectionPath = path.resolve(repoRoot, baseline.projection.path);
const projectionBytes = fs.readFileSync(projectionPath);
const catalog = JSON.parse(projectionBytes.toString("utf8"));
const models = catalog.models;

if (baseline.upstream.tag !== upstream.tag) {
  fail("model tag does not match the protocol baseline");
}
if (baseline.upstream.commit !== upstream.commit) {
  fail("model commit does not match the protocol baseline");
}
if (!Array.isArray(models) || models.length === 0) {
  fail("projection must contain a non-empty models array");
}
if (sha256(projectionBytes) !== baseline.projection.sha256) {
  fail("projection SHA-256 changed; regenerate and review the pinned catalog");
}

const ids = models.map((model) => model.id);
if (new Set(ids).size !== ids.length) {
  fail("model ids must be unique");
}
if (JSON.stringify(ids) !== JSON.stringify(baseline.projection.modelIds)) {
  fail("model order or ids changed");
}
if (models.length !== baseline.projection.modelCount) {
  fail("model count changed");
}

const visible = models.filter((model) => model.hidden === false);
if (visible.length !== baseline.projection.visibleModelCount) {
  fail("visible model count changed");
}
const defaults = models.filter((model) => model.isDefault === true);
if (
  defaults.length !== 1 ||
  defaults[0].id !== baseline.projection.defaultModel
) {
  fail("catalog must have exactly one expected default model");
}

for (const model of models) {
  if (
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    model.model !== model.id ||
    typeof model.displayName !== "string" ||
    typeof model.description !== "string" ||
    typeof model.hidden !== "boolean" ||
    !Array.isArray(model.supportedReasoningEfforts) ||
    !Array.isArray(model.inputModalities) ||
    !Array.isArray(model.serviceTiers)
  ) {
    fail(`invalid V2 model projection: ${JSON.stringify(model.id)}`);
  }
}

console.log(
  `Codex model baseline OK: ${models.length} models, ${visible.length} visible, default ${defaults[0].id}`,
);
