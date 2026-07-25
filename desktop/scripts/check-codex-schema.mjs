import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const codexRoot = path.join(repoRoot, "shared/codex/v2");
const schemaDir = path.join(codexRoot, "schema");
const compatibilitySchemaDir = path.join(codexRoot, "compat-schema");
const typescriptDir = path.join(codexRoot, "typescript");
const baseline = JSON.parse(
  fs.readFileSync(path.join(codexRoot, "upstream-baseline.json"), "utf8"),
);
const manifestPath = path.join(codexRoot, "schema-manifest.json");

function filesUnder(root, extension) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.name.endsWith(extension)) {
        result.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      }
    }
  };
  visit(root);
  return result.sort();
}

function treeHash(root, files) {
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function methodsFromSchema(file) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
  return schema.oneOf.map(
    (entry) => entry.properties.method.enum[0],
  );
}

function assertSameMethods(surface, schemaFile) {
  const expected = baseline.surfaces[surface]
    .map((entry) => entry.method)
    .sort();
  const actual = methodsFromSchema(schemaFile).sort();
  if (
    expected.length !== actual.length ||
    expected.some((method, index) => method !== actual[index])
  ) {
    throw new Error(`${surface} 与固定 Codex Schema 不一致`);
  }
}

const schemaFiles = filesUnder(schemaDir, ".json");
const typescriptFiles = filesUnder(typescriptDir, ".ts");
const elicitationSource = JSON.parse(
  fs.readFileSync(
    path.join(schemaDir, "McpServerElicitationRequestParams.json"),
    "utf8",
  ),
);
const elicitationDefinitions = { ...elicitationSource.definitions };
delete elicitationDefinitions.McpElicitationSchema;
const elicitationCompatibilitySchema = {
  ...elicitationSource.definitions.McpElicitationSchema,
  $schema: elicitationSource.$schema,
  title: "McpElicitationSchema",
  definitions: elicitationDefinitions,
};
const compatibilitySchemaPath = path.join(
  compatibilitySchemaDir,
  "McpElicitationSchema.json",
);
const compatibilitySchemaContent = `${JSON.stringify(
  elicitationCompatibilitySchema,
  null,
  2,
)}\n`;
const manifest = {
  codexVersion: baseline.codexVersion,
  tag: baseline.tag,
  commit: baseline.commit,
  schemaFiles: schemaFiles.length,
  typescriptFiles: typescriptFiles.length,
  schemaSha256: treeHash(schemaDir, schemaFiles),
  typescriptSha256: treeHash(typescriptDir, typescriptFiles),
  compatibilitySchemaSha256: crypto
    .createHash("sha256")
    .update(compatibilitySchemaContent)
    .digest("hex"),
};

assertSameMethods("clientRequests", "ClientRequest.json");
assertSameMethods("clientNotifications", "ClientNotification.json");
assertSameMethods("serverRequests", "ServerRequest.json");
assertSameMethods("serverNotifications", "ServerNotification.json");

for (const relative of typescriptFiles) {
  const content = fs.readFileSync(path.join(typescriptDir, relative), "utf8");
  if (!content.startsWith("// GENERATED CODE! DO NOT MODIFY BY HAND!")) {
    throw new Error(`TypeScript 快照缺少生成标记：${relative}`);
  }
}

if (process.argv.includes("--write")) {
  fs.mkdirSync(compatibilitySchemaDir, { recursive: true });
  fs.writeFileSync(compatibilitySchemaPath, compatibilitySchemaContent);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  const actualCompatibilitySchema = fs.existsSync(compatibilitySchemaPath)
    ? fs.readFileSync(compatibilitySchemaPath, "utf8")
    : "";
  if (actualCompatibilitySchema !== compatibilitySchemaContent) {
    throw new Error(
      "Codex Rust 兼容 Schema 已过期，请运行 pnpm check:codex-schema -- --write",
    );
  }
  const expected = `${JSON.stringify(manifest, null, 2)}\n`;
  const actual = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, "utf8")
    : "";
  if (actual !== expected) {
    throw new Error(
      "Codex Schema 清单已过期，请运行 pnpm check:codex-schema -- --write",
    );
  }
}

process.stdout.write(
  `Codex schema OK: ${manifest.schemaFiles} JSON, ${manifest.typescriptFiles} TypeScript\n`,
);
