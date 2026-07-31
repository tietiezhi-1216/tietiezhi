import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { app, dialog } from "electron";

import type { SkillDetail, SkillInput, SkillSummary } from "@shared/contracts";

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function skillName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(normalized)) {
    throw new Error("技能名称只能包含小写字母、数字和横线，且最长 64 个字符");
  }
  return normalized;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSkill(content: string, fallbackName: string, enabled: boolean): SkillDetail {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/.exec(content);
  const frontmatter = match?.[1] ?? "";
  const values = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const field = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (field?.[1] && field[2] !== undefined) values.set(field[1], unquote(field[2]));
  }
  return {
    name: skillName(values.get("name") || fallbackName),
    description: (values.get("description") ?? "").slice(0, 500),
    enabled,
    body: match ? content.slice(match[0].length) : content,
  };
}

function serializeSkill(input: SkillInput): string {
  const name = skillName(input.name);
  const description = input.description.trim().replace(/\s+/g, " ").slice(0, 500);
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

export class SkillService {
  readonly #root = join(app.getPath("userData"), "skills");
  readonly #disabledPath = join(this.#root, ".disabled.json");

  async #disabled(): Promise<Set<string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#disabledPath, "utf8"));
      return new Set(
        Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }

  async #writeDisabled(disabled: Set<string>): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await writeFile(this.#disabledPath, JSON.stringify([...disabled].sort(), null, 2), "utf8");
  }

  async list(): Promise<SkillSummary[]> {
    await mkdir(this.#root, { recursive: true });
    const disabled = await this.#disabled();
    const entries = await readdir(this.#root, { withFileTypes: true });
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && SKILL_NAME_PATTERN.test(entry.name))
        .map(async (entry): Promise<SkillSummary | null> => {
          try {
            const detail = parseSkill(
              await readFile(join(this.#root, entry.name, "SKILL.md"), "utf8"),
              entry.name,
              !disabled.has(entry.name),
            );
            return {
              name: detail.name,
              description: detail.description,
              enabled: detail.enabled,
            };
          } catch {
            return null;
          }
        }),
    );
    return skills
      .filter((item): item is SkillSummary => item !== null)
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  async read(name: string): Promise<SkillDetail> {
    const normalized = skillName(name);
    const disabled = await this.#disabled();
    const content = await readFile(join(this.#root, normalized, "SKILL.md"), "utf8");
    return parseSkill(content, normalized, !disabled.has(normalized));
  }

  async save(input: SkillInput): Promise<SkillDetail> {
    const normalized = skillName(input.name);
    const directory = join(this.#root, normalized);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), serializeSkill({ ...input, name: normalized }), "utf8");
    return this.read(normalized);
  }

  async remove(name: string): Promise<void> {
    const normalized = skillName(name);
    await rm(join(this.#root, normalized), { recursive: true, force: true });
    const disabled = await this.#disabled();
    disabled.delete(normalized);
    await this.#writeDisabled(disabled);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const normalized = skillName(name);
    await this.read(normalized);
    const disabled = await this.#disabled();
    if (enabled) disabled.delete(normalized);
    else disabled.add(normalized);
    await this.#writeDisabled(disabled);
  }

  async import(): Promise<SkillDetail | null> {
    const result = await dialog.showOpenDialog({
      title: "导入技能文件夹",
      properties: ["openDirectory"],
    });
    const source = result.filePaths[0];
    if (result.canceled || source === undefined) return null;
    const sourceContent = await readFile(join(source, "SKILL.md"), "utf8");
    const parsed = parseSkill(sourceContent, basename(source), true);
    const target = join(this.#root, parsed.name);
    await mkdir(this.#root, { recursive: true });
    try {
      await readFile(join(target, "SKILL.md"), "utf8");
      throw new Error(`技能 ${parsed.name} 已存在`);
    } catch (error) {
      if (error instanceof Error && error.message === `技能 ${parsed.name} 已存在`) throw error;
    }
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    return this.read(parsed.name);
  }

  async enabled(): Promise<SkillDetail[]> {
    const summaries = await this.list();
    return Promise.all(
      summaries.filter((skill) => skill.enabled).map((skill) => this.read(skill.name)),
    );
  }
}
