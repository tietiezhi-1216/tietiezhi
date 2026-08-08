import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  AgentDefinition,
  AgentPreset,
  CreateAgentInput,
} from "@shared/contracts";

import { AppDatabase } from "../infrastructure/database.js";

const DEFAULT_PRESETS: AgentPreset[] = [
  {
    id: "principal",
    name: "主理人",
    role: "任务协调",
    description: "拆解目标、安排协作，并把多个智能体的结果整理成可执行结论。",
  },
  {
    id: "engineer",
    name: "工程师",
    role: "软件开发",
    description: "负责分析代码、实现方案、定位故障，并清楚说明改动和风险。",
  },
  {
    id: "researcher",
    name: "研究员",
    role: "信息研究",
    description: "收集资料、比较方案、标注依据，输出结构化研究结论。",
  },
  {
    id: "designer",
    name: "设计师",
    role: "产品与视觉",
    description: "关注用户流程、界面层级和细节体验，提出可落地的设计方案。",
  },
  {
    id: "reviewer",
    name: "审查员",
    role: "质量审查",
    description: "从正确性、边界条件和维护成本出发，发现问题并给出改进建议。",
  },
];

export class AgentProfileService {
  readonly #agentsRoot: string;

  constructor(
    private readonly database: AppDatabase,
    agentsRoot: string,
  ) {
    this.#agentsRoot = agentsRoot;
    mkdirSync(agentsRoot, { recursive: true });
    for (const preset of DEFAULT_PRESETS) this.database.saveAgentPreset(preset);
  }

  list(): AgentDefinition[] {
    return this.database.listAgents();
  }

  presets(): AgentPreset[] {
    return this.database.listAgentPresets();
  }

  require(id: string): AgentDefinition {
    const agent = this.database.agent(id);
    if (!agent) throw new Error("智能体不存在");
    return agent;
  }

  systemPrompt(id: string): string {
    const agent = this.require(id);
    const stored = this.database.agentSystemPrompt(id);
    if (stored?.trim()) return stored;
    const preset = agent.presetId
      ? this.database.listAgentPresets().find((item) => item.id === agent.presetId)
      : undefined;
    return [
      `你是「${agent.name}」，角色是${agent.role}。`,
      agent.description,
      preset ? `你继承了“${preset.name}”智能体的工作方向。` : "",
      "请保持角色一致，先理解目标，再给出清晰、可执行的结果。不要虚构已经完成的操作。",
    ].filter(Boolean).join("\n");
  }

  create(input: CreateAgentInput): AgentDefinition {
    const name = input.name.trim().slice(0, 60);
    const role = input.role.trim().slice(0, 60);
    if (!name) throw new Error("智能体名称不能为空");
    if (!role) throw new Error("智能体角色不能为空");

    const preset = input.presetId
      ? this.database.listAgentPresets().find((item) => item.id === input.presetId)
      : undefined;
    if (input.presetId && !preset) throw new Error("智能体预设不存在");

    const id = randomUUID();
    const now = Date.now();
    const homePath = join(this.#agentsRoot, id);
    const description = (input.description?.trim() || preset?.description || "").slice(0, 500);
    const systemPrompt = input.systemPrompt?.trim() || this.defaultPrompt(name, role, description);
    const agent: AgentDefinition = {
      id,
      name,
      role,
      description,
      avatar: input.avatar?.trim() || preset?.avatar,
      modelId: input.modelId?.trim() || preset?.defaultModelId,
      availability: "idle",
      isBuiltIn: false,
      presetId: preset?.id,
      createdAt: now,
      updatedAt: now,
    };

    mkdirSync(join(homePath, "memory"), { recursive: true });
    mkdirSync(join(homePath, "skills"), { recursive: true });
    mkdirSync(join(homePath, "sessions"), { recursive: true });
    writeFileSync(join(homePath, "agent.json"), JSON.stringify({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      presetId: agent.presetId,
      createdAt: agent.createdAt,
    }, null, 2) + "\n", "utf8");
    writeFileSync(join(homePath, "prompt.md"), `${systemPrompt}\n`, "utf8");
    this.database.saveAgent(agent, systemPrompt, homePath);
    return agent;
  }

  private defaultPrompt(name: string, role: string, description: string): string {
    return [
      `你是「${name}」，负责${role}。`,
      description,
      "先确认目标和约束，再分步执行；遇到不确定内容要明确说明。",
    ].filter(Boolean).join("\n");
  }
}
