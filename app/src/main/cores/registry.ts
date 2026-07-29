/**
 * The built-in catalogue of cores the host knows how to run.
 *
 * Descriptors are built lazily rather than declared as constants because the
 * command path, and the config directory we inject through the environment,
 * both depend on `app.getPath("userData")`, which is only meaningful once
 * Electron has resolved it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreDescriptor, CoreSource, McpConfigFormat } from "@shared/contracts";
import { coreConfigDir, coreInstallDir, executableName } from "./paths";

/**
 * How much we actually know about a CLI's config-dir environment variable.
 * Surfaced so the settings UI can warn instead of silently trusting a guess.
 */
export type EnvConfidence = "documented" | "community" | "unverified";

/**
 * Whether the variable names the config directory itself, or a home directory
 * under which the CLI creates its own dotfolder.
 */
type ConfigDirLayout = "config-dir" | "home-dir";

interface ConfigEnvSpec {
  name: string;
  layout: ConfigDirLayout;
  /** Dotfolder the CLI creates when `layout === "home-dir"`. */
  childDir?: string;
  confidence: EnvConfidence;
}

export interface CoreTemplate {
  id: string;
  name: string;
  summary: string;
  source: CoreSource;
  firstParty: boolean;
  configFormat: McpConfigFormat;
  packageName?: string;
  version?: string;
  /** Key in the package's `bin` map; also the file dropped into `node_modules/.bin`. */
  binName?: string;
  /** Fallback entry path inside the package, used before install or if `bin` is unreadable. */
  binPath?: string;
  args: string[];
  configEnv?: ConfigEnvSpec;
  extraEnv?: Record<string, string>;
}

const TEMPLATES: readonly CoreTemplate[] = [
  {
    id: "tietiezhi",
    name: "铁铁汁核心",
    summary: "第一方 Rust 核心，拥有完整协议面：文件系统、终端、计划与审批全部由宿主接管。",
    source: "builtin",
    firstParty: true,
    configFormat: "none",
    args: ["acp"],
    configEnv: {
      name: "TIETIEZHI_CORE_CONFIG_DIR",
      layout: "config-dir",
      confidence: "documented",
    },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    summary: "Anthropic Claude Code，经 claude-code-acp 适配层接入。运行在自己的内核里，宿主只统一渲染审批。",
    source: "npm",
    firstParty: false,
    configFormat: "claude-json",
    packageName: "@zed-industries/claude-code-acp",
    version: "0.16.2",
    binName: "claude-code-acp",
    binPath: "dist/index.js",
    args: [],
    configEnv: {
      name: "CLAUDE_CONFIG_DIR",
      layout: "config-dir",
      confidence: "community",
    },
  },
  {
    id: "codex",
    name: "Codex",
    summary: "OpenAI Codex，经 codex-acp 适配层接入。沙箱与审批策略由 Codex 自身内核决定。",
    source: "npm",
    firstParty: false,
    configFormat: "codex-toml",
    packageName: "@agentclientprotocol/codex-acp",
    version: "1.1.7",
    binName: "codex-acp",
    binPath: "dist/index.js",
    args: [],
    configEnv: {
      name: "CODEX_HOME",
      layout: "config-dir",
      confidence: "documented",
    },
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    summary: "Google Gemini CLI，原生支持 ACP，用 --acp 启动即为 JSON-RPC over stdio 的 agent。",
    source: "npm",
    firstParty: false,
    configFormat: "gemini-json",
    packageName: "@google/gemini-cli",
    version: "0.53.0",
    binName: "gemini",
    binPath: "bundle/gemini.js",
    args: ["--acp"],
    configEnv: {
      // GEMINI_CLI_HOME is a *home*: the CLI creates `.gemini` beneath it.
      name: "GEMINI_CLI_HOME",
      layout: "home-dir",
      childDir: ".gemini",
      confidence: "documented",
    },
  },
];

const TEMPLATES_BY_ID = new Map<string, CoreTemplate>(TEMPLATES.map((t) => [t.id, t]));

/** Where one core's configuration actually lives on disk. */
export interface CoreConfigPaths {
  coreId: string;
  /** Value we put in the environment variable. */
  envValue: string;
  /** Directory the CLI really reads its settings from — what a projector writes into. */
  settingsDir: string;
  /** Name of the variable, absent when the core has no relocation knob. */
  envName?: string;
  confidence: EnvConfidence;
}

function configPathsFor(template: CoreTemplate): CoreConfigPaths {
  const base = coreConfigDir(template.id);
  const spec = template.configEnv;
  if (spec === undefined) {
    return { coreId: template.id, envValue: base, settingsDir: base, confidence: "unverified" };
  }
  const settingsDir =
    spec.layout === "home-dir" && spec.childDir !== undefined ? join(base, spec.childDir) : base;
  return {
    coreId: template.id,
    envValue: base,
    settingsDir,
    envName: spec.name,
    confidence: spec.confidence,
  };
}

/**
 * A package's `bin` field is the only authoritative entry path, so prefer the
 * installed copy over our hard-coded default — the pinned version can change
 * its layout without us noticing otherwise.
 */
function readInstalledBin(pkgDir: string, binName: string | undefined): string | undefined {
  const manifest = join(pkgDir, "package.json");
  if (!existsSync(manifest)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const bin = (parsed as { bin?: unknown }).bin;
  if (typeof bin === "string") return bin;
  if (typeof bin !== "object" || bin === null) return undefined;
  const map = bin as Record<string, unknown>;
  if (binName !== undefined) {
    const direct = map[binName];
    if (typeof direct === "string") return direct;
  }
  for (const value of Object.values(map)) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Absolute path of the JS entry point of an installed npm core. */
export function npmEntryPath(template: CoreTemplate): string {
  const packageName = template.packageName ?? template.id;
  const pkgDir = join(coreInstallDir(template.id), "node_modules", ...packageName.split("/"));
  const rel = readInstalledBin(pkgDir, template.binName) ?? template.binPath ?? "index.js";
  return join(pkgDir, rel);
}

function builtinCommand(): string {
  const override = process.env.TIETIEZHI_CORE_PATH;
  if (override !== undefined && override.length > 0) return override;
  // Placeholder: the Rust core's ACP adapter is not built yet. Once it ships it
  // will be bundled under the app's resources directory at this path.
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const root = resources !== undefined && resources.length > 0 ? resources : process.cwd();
  return join(root, "bin", executableName("tietiezhi-core"));
}

function buildDescriptor(template: CoreTemplate): CoreDescriptor {
  const paths = configPathsFor(template);
  const env: Record<string, string> = { ...template.extraEnv };
  if (paths.envName !== undefined) env[paths.envName] = paths.envValue;

  const base = {
    id: template.id,
    name: template.name,
    summary: template.summary,
    source: template.source,
    configFormat: template.configFormat,
    firstParty: template.firstParty,
  };

  if (template.source === "npm") {
    return {
      ...base,
      packageName: template.packageName,
      version: template.version,
      // Run the agent on Electron's own bundled Node: a packaged app cannot
      // assume the user has `node` on PATH, and the .bin shims would need one.
      command: process.execPath,
      args: [npmEntryPath(template), ...template.args],
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  return {
    ...base,
    version: template.version,
    command: builtinCommand(),
    args: [...template.args],
    env,
  };
}

/** Every core the app ships knowledge of, in display order. */
export function listCores(): CoreDescriptor[] {
  return TEMPLATES.map(buildDescriptor);
}

/** One core by id, or `undefined` when the id is unknown. */
export function getCore(id: string): CoreDescriptor | undefined {
  const template = TEMPLATES_BY_ID.get(id);
  return template === undefined ? undefined : buildDescriptor(template);
}

/** Same as {@link getCore} but throws, for call sites that already validated the id. */
export function requireCore(id: string): CoreDescriptor {
  const descriptor = getCore(id);
  if (descriptor === undefined) throw new Error(`unknown core: ${id}`);
  return descriptor;
}

/**
 * Where to write this core's config projection. Config projectors should use
 * `settingsDir` and never guess at `~/.claude` style locations.
 */
export function getCoreConfigPaths(id: string): CoreConfigPaths | undefined {
  const template = TEMPLATES_BY_ID.get(id);
  return template === undefined ? undefined : configPathsFor(template);
}

/** npm prefix for a core, exposed so the installer and the spawner agree on it. */
export function getCoreInstallDir(id: string): string {
  return coreInstallDir(id);
}

/** Internal template lookup, used by the installer to reach `packageName`/`version`. */
export function getCoreTemplate(id: string): Readonly<CoreTemplate> | undefined {
  return TEMPLATES_BY_ID.get(id);
}
