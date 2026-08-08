import { randomUUID } from "node:crypto";

import type { AgentGroup, CreateAgentGroupInput } from "@shared/contracts";

import { AgentProfileService } from "./agent-profile-service.js";
import { AppDatabase } from "../infrastructure/database.js";

export class AgentGroupService {
  constructor(
    private readonly database: AppDatabase,
    private readonly agentProfiles: AgentProfileService,
  ) {}

  list(): AgentGroup[] {
    return this.database.listAgentGroups();
  }

  require(id: string): AgentGroup {
    const group = this.list().find((item) => item.id === id);
    if (!group) throw new Error("群聊不存在");
    return group;
  }

  create(input: CreateAgentGroupInput): AgentGroup {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error("群聊名称不能为空");
    const agentIds = [...new Set(input.agentIds.map((id) => id.trim()).filter(Boolean))];
    if (agentIds.length < 2) throw new Error("群聊至少需要选择两个智能体");
    for (const agentId of agentIds) this.agentProfiles.require(agentId);
    const now = Date.now();
    const group: AgentGroup = {
      id: randomUUID(),
      name,
      description: input.description?.trim().slice(0, 240) ?? "",
      agentIds,
      createdAt: now,
      updatedAt: now,
    };
    this.database.transaction(() => this.database.saveAgentGroup(group));
    return group;
  }

  remove(id: string): void {
    if (!this.database.removeAgentGroup(id)) throw new Error("群聊不存在");
  }
}
