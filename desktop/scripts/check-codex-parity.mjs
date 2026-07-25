import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const baselinePath = path.join(
  repoRoot,
  "shared/codex/v2/upstream-baseline.json",
);
const documentPath = path.join(repoRoot, "docs/CODEX-PARITY.md");
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

const expectedCounts = {
  clientRequests: 89,
  clientNotifications: 1,
  serverRequests: 10,
  serverNotifications: 70,
};
const expectedMilestones = Array.from({ length: 40 }, (_, index) => `R${index}`);
const expectedThreadItemTypes = [
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
  "fileChange",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "plan",
  "reasoning",
  "sleep",
  "subAgentActivity",
  "userMessage",
  "webSearch",
];
const expectedUserInputTypes = [
  "audio",
  "image",
  "localAudio",
  "localImage",
  "mention",
  "skill",
  "text",
];
const errors = [];

function sameValues(actual, expected) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

if (baseline.codexVersion !== "0.145.0") {
  errors.push(`Codex version changed unexpectedly: ${baseline.codexVersion}`);
}
if (baseline.tag !== "rust-v0.145.0") {
  errors.push(`Codex tag changed unexpectedly: ${baseline.tag}`);
}
if (baseline.commit !== "25af12f7e61572b0bc18ddb1008be543b91519b0") {
  errors.push(`Codex commit changed unexpectedly: ${baseline.commit}`);
}
if (baseline.protocol !== "app-server-v2") {
  errors.push(`Unexpected protocol: ${baseline.protocol}`);
}

for (const [surface, expectedCount] of Object.entries(expectedCounts)) {
  const entries = baseline.surfaces?.[surface];
  if (!Array.isArray(entries)) {
    errors.push(`Missing surface: ${surface}`);
    continue;
  }
  if (entries.length !== expectedCount) {
    errors.push(`${surface} has ${entries.length} entries, expected ${expectedCount}`);
  }
  const methods = entries.map((entry) => entry.method);
  if (new Set(methods).size !== methods.length) {
    errors.push(`${surface} contains duplicate methods`);
  }
  for (const entry of entries) {
    if (!baseline.allowedStatuses.includes(entry.status)) {
      errors.push(`${entry.method} has invalid status: ${entry.status}`);
    }
    if (!/^R(?:[0-9]|[1-3][0-9])$/.test(entry.target)) {
      errors.push(`${entry.method} has invalid target: ${entry.target}`);
    }
    if (typeof entry.note !== "string") {
      errors.push(`${entry.method} note must be a string`);
    }
    if (entry.status === "implemented" && entry.note.trim() === "") {
      errors.push(`${entry.method} is implemented without evidence in note`);
    }
    if (entry.status === "service_mapped" && entry.note.trim() === "") {
      errors.push(`${entry.method} is service_mapped without evidence in note`);
    }
  }
}

if (!sameValues(baseline.threadItemTypes, expectedThreadItemTypes)) {
  errors.push("ThreadItem types no longer match the pinned upstream baseline");
}
if (!sameValues(baseline.userInputTypes, expectedUserInputTypes)) {
  errors.push("UserInput types no longer match the pinned upstream baseline");
}

const milestoneIds = baseline.milestones?.map((milestone) => milestone.id) ?? [];
if (!sameValues(milestoneIds, expectedMilestones)) {
  errors.push("Milestone ledger must contain every stage from R0 through R39");
}
for (const milestone of baseline.milestones ?? []) {
  if (!baseline.milestoneStatuses.includes(milestone.status)) {
    errors.push(`${milestone.id} has invalid milestone status: ${milestone.status}`);
  }
  if (milestone.status === "completed" && milestone.evidence.trim() === "") {
    errors.push(`${milestone.id} is completed without evidence`);
  }
}

const serialized = JSON.stringify(baseline).toLowerCase();
if (serialized.includes("unsupported") || serialized.includes("不支持")) {
  errors.push("Parity ledger must not use unsupported as a terminal state");
}

const statusLabels = {
  pending: "待实现",
  in_progress: "实现中",
  implemented: "已实现",
  service_mapped: "服务映射",
};
const milestoneStatusLabels = {
  pending: "待开始",
  in_progress: "进行中",
  completed: "已完成",
};

function countStatuses(entries) {
  return baseline.allowedStatuses.map((status) => ({
    status,
    count: entries.filter((entry) => entry.status === status).length,
  }));
}

function renderSurface(title, entries) {
  const lines = [
    `## ${title}`,
    "",
    "| 方法 | 状态 | 目标阶段 | 证据或备注 |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of entries) {
    lines.push(
      `| \`${entry.method}\` | ${statusLabels[entry.status]} | ${entry.target} | ${entry.note || ""} |`,
    );
  }
  return lines.join("\n");
}

function renderDocument() {
  const allEntries = Object.values(baseline.surfaces).flat();
  const summaryRows = countStatuses(allEntries)
    .map(({ status, count }) => `| ${statusLabels[status]} | ${count} |`)
    .join("\n");
  const milestoneRows = baseline.milestones
    .map(
      (milestone) =>
        `| ${milestone.id} | ${milestone.name} | ${milestoneStatusLabels[milestone.status]} | ${milestone.evidence || ""} | ${milestone.risk || ""} |`,
    )
    .join("\n");

  return `# Codex V2 功能对齐

> 本文件由 \`desktop/scripts/check-codex-parity.mjs --write\` 根据机器可读 ledger 生成。状态更新应先修改 \`shared/codex/v2/upstream-baseline.json\`，再重新生成本文档。

## 固定基线

- Codex 版本：\`${baseline.codexVersion}\`
- Git Tag：\`${baseline.tag}\`
- Git Commit：\`${baseline.commit}\`
- 协议：\`${baseline.protocol}\`
- 上游源码：${baseline.source}
- 许可证：\`${baseline.license}\`
- 捕获日期：\`${baseline.capturedAt}\`
- 客户端请求：${baseline.surfaces.clientRequests.length}
- 客户端通知：${baseline.surfaces.clientNotifications.length}
- 服务端请求：${baseline.surfaces.serverRequests.length}
- 服务端通知：${baseline.surfaces.serverNotifications.length}
- Thread Item 类型：${baseline.threadItemTypes.length}
- User Input 类型：${baseline.userInputTypes.length}

## 状态规则

- \`pending\`：尚未实现，但已分配目标阶段。
- \`in_progress\`：当前阶段正在实现，不能作为发布完成状态。
- \`implemented\`：已实现且必须在备注中给出源码与测试证据。
- \`service_mapped\`：Codex 依赖专有服务时映射到 Tietiezhi 服务，并在备注中给出证据。
- Ledger 不允许使用“永久不支持”作为终态。
- 每完成一个 R 阶段必须更新阶段状态、方法状态、证据和剩余风险。

| 方法状态 | 数量 |
| --- | ---: |
${summaryRows}

## 阶段进度

| 阶段 | 名称 | 状态 | 证据 | 剩余风险 |
| --- | --- | --- | --- | --- |
${milestoneRows}

${renderSurface("Client Requests", baseline.surfaces.clientRequests)}

${renderSurface("Client Notifications", baseline.surfaces.clientNotifications)}

${renderSurface("Server Requests", baseline.surfaces.serverRequests)}

${renderSurface("Server Notifications", baseline.surfaces.serverNotifications)}

## Thread Item 类型

${baseline.threadItemTypes.map((type) => `- \`${type}\``).join("\n")}

## User Input 类型

${baseline.userInputTypes.map((type) => `- \`${type}\``).join("\n")}
`;
}

const expectedDocument = renderDocument();
if (process.argv.includes("--write")) {
  fs.writeFileSync(documentPath, expectedDocument);
} else if (!fs.existsSync(documentPath)) {
  errors.push("Missing docs/CODEX-PARITY.md; run check:codex-parity -- --write");
} else if (
  fs.readFileSync(documentPath, "utf8").replaceAll("\r\n", "\n") !==
  expectedDocument
) {
  errors.push(
    "docs/CODEX-PARITY.md is stale; run pnpm check:codex-parity -- --write",
  );
}

if (errors.length > 0) {
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Codex parity baseline OK: ${Object.values(expectedCounts).reduce((sum, count) => sum + count, 0)} methods, ${baseline.milestones.length} milestones`,
);
