//! Dev-only stub of the Tauri IPC bridge.
//!
//! Lets the UI be driven in a plain browser — `pnpm dev:mock`, then open
//! http://localhost:1421/?mock=1 — with no Rust side running, which is how the
//! UI gets checked without disturbing the real `pnpm tauri dev` on port 1420.
//!
//! Never reaches a release build: the entry points import it behind
//! `import.meta.env.DEV`, so the dynamic import is dead code in production.

import type {
  AutomationDocument,
  AutomationMeta,
  AutomationValidationIssue,
  ChatAttachment,
  DeviceCore,
  ModelInfo,
  Provider,
  TietiezhiDevice,
} from "@/lib/api";

const createMockAutomation = (): AutomationDocument => {
  const timestamp = Date.now() - 420_000;
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: "每日需求分拣",
    description: "汇总新需求，交给 Agent 分类后输出处理建议。",
    revision: 0,
    nodes: [
      {
        id: "trigger",
        type: "scheduleTrigger",
        typeVersion: 1,
        name: "工作日 9:00",
        position: { x: 80, y: 180 },
        disabled: false,
        config: { cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
        inputs: {},
      },
      {
        id: "agent",
        type: "agent",
        typeVersion: 1,
        name: "需求分类 Agent",
        position: { x: 390, y: 180 },
        disabled: false,
        config: { agentId: "agent-coder", prompt: "分类并给出处理优先级" },
        inputs: { input: { kind: "nodeOutput", nodeId: "trigger", path: "/" } },
      },
      {
        id: "output",
        type: "output",
        typeVersion: 1,
        name: "输出处理建议",
        position: { x: 700, y: 180 },
        disabled: false,
        config: {},
        inputs: { input: { kind: "nodeOutput", nodeId: "agent", path: "/" } },
      },
    ],
    edges: [
      {
        id: "edge-trigger-agent",
        sourceNodeId: "trigger",
        sourcePort: "output",
        targetNodeId: "agent",
        targetPort: "input",
      },
      {
        id: "edge-agent-output",
        sourceNodeId: "agent",
        sourcePort: "output",
        targetNodeId: "output",
        targetPort: "input",
      },
    ],
    settings: {
      timezone: "Asia/Shanghai",
      maxDurationMs: 300_000,
      maxConcurrency: 4,
      onMissedSchedule: "skip",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const automationMeta = (
  automation: AutomationDocument,
  archivedAt = 0,
): AutomationMeta => ({
  id: automation.id,
  name: automation.name,
  description: automation.description,
  revision: automation.revision,
  nodeCount: automation.nodes.length,
  triggerType:
    automation.nodes.find(
      (node) => node.type === "manualTrigger" || node.type === "scheduleTrigger",
    )?.type ?? "",
  createdAt: automation.createdAt,
  updatedAt: automation.updatedAt,
  archivedAt,
});

const validateMockAutomation = (
  automation: AutomationDocument,
  publish: boolean,
): AutomationValidationIssue[] => {
  const issues: AutomationValidationIssue[] = [];
  const nodeIds = new Set<string>();
  for (const node of automation.nodes) {
    if (!node.id || nodeIds.has(node.id)) {
      issues.push({
        code: "duplicate_node_id",
        message: "节点 ID 不能为空且不能重复",
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
  }
  for (const node of automation.nodes) {
    for (const binding of Object.values(node.inputs)) {
      if (binding.kind !== "nodeOutput") continue;
      if (binding.nodeId === node.id) {
        issues.push({
          code: "self_binding",
          message: "节点输入不能引用自身输出",
          nodeId: node.id,
        });
      } else if (!nodeIds.has(binding.nodeId)) {
        issues.push({
          code: "missing_binding_node",
          message: "节点输入引用了不存在的上游节点",
          nodeId: node.id,
        });
      }
    }
  }
  const indegree = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of automation.edges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      issues.push({
        code: "dangling_edge",
        message: "连线引用了不存在的节点",
        edgeId: edge.id,
      });
    }
    if (edge.sourceNodeId === edge.targetNodeId) {
      issues.push({
        code: "self_edge",
        message: "节点不能连接到自身",
        edgeId: edge.id,
      });
    }
    if (nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)) {
      indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
      outgoing.set(edge.sourceNodeId, [
        ...(outgoing.get(edge.sourceNodeId) ?? []),
        edge.targetNodeId,
      ]);
    }
  }
  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop();
    if (!id) continue;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const degree = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  if (visited !== nodeIds.size) {
    issues.push({ code: "cycle", message: "工作流不能包含任意图环" });
  }
  if (publish) {
    const triggerCount = automation.nodes.filter(
      (node) =>
        !node.disabled &&
        (node.type === "manualTrigger" || node.type === "scheduleTrigger"),
    ).length;
    if (triggerCount !== 1) {
      issues.push({
        code: "trigger_count",
        message: "发布版本必须且只能包含一个启用的触发器",
      });
    }
    if (!automation.nodes.some((node) => !node.disabled && node.type === "output")) {
      issues.push({ code: "missing_output", message: "发布版本至少需要一个输出节点" });
    }
  }
  return issues;
};

const capableChatModel = (id: string): ModelInfo => ({
  id,
  kind: "chat",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  capabilities: ["tool-call", "reasoning", "structured-output"],
  reasoning: {
    mode: "effort",
    supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    transport: "openai-reasoning-effort",
  },
  capabilitySource: "registry",
  contextWindow: 256 * 1024,
});

const TERLN_MODELS: ModelInfo[] = ([
  { id: "agnes-1.5-flash", kind: "chat" },
  { id: "agnes-2.0-flash", kind: "chat" },
  { id: "agnes-image-2.1-flash", kind: "image" },
  { id: "agnes-music-v1", kind: "audio" },
  { id: "agnes-sound-v1", kind: "audio" },
  { id: "agnes-video-v2.0", kind: "video" },
  { id: "claude-opus-4-6-thinking", kind: "chat" },
  { id: "claude-sonnet-4-6", kind: "chat" },
  { id: "codex-auto-review", kind: "chat" },
  {
    id: "deepseek-v4-flash",
    kind: "chat",
    inputModalities: ["text"],
    outputModalities: ["text"],
    capabilities: ["tool-call", "reasoning"],
    reasoning: {
      mode: "effort",
      supportedEfforts: ["off", "low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      transport: "openai-reasoning-effort",
    },
    capabilitySource: "registry",
  },
  { id: "gemini-2.5-flash", kind: "chat" },
  { id: "gemini-2.5-flash-image", kind: "image" },
  { id: "gemini-2.5-pro", kind: "chat" },
  { id: "gemini-3-flash", kind: "chat" },
  { id: "gemini-3.1-pro-high", kind: "chat" },
  capableChatModel("gpt-5.4"),
  capableChatModel("gpt-5.4-mini"),
  capableChatModel("gpt-5.5"),
  capableChatModel("gpt-5.6-luna"),
  { id: "gpt-image-2", kind: "image" },
  { id: "gpt-oss-120b-medium", kind: "chat" },
  { id: "sensenova-u1-fast", kind: "image" },
] satisfies ModelInfo[]).map((model) => ({ ...model, contextWindow: 256 * 1024 }));

const MIMO_MODELS: ModelInfo[] = ([
  { id: "mimo-v2.5-pro", kind: "chat" },
  { id: "mimo-v2.5-asr", kind: "asr" },
  { id: "mimo-v2.5-tts", kind: "tts" },
] satisfies ModelInfo[]).map((model) => ({ ...model, contextWindow: 256 * 1024 }));

const DEFAULT_PROMPT = `# 角色
你是语音输入整理器。先理解用户意图，再贴着原句做语法整理与轻度润色。

# 规则
- 去掉口癖与重复，理顺语法与语序；不扩写、不臆造用户没说的事实。
- 中英混输、专有名词、代码 / 命令 / 路径 / URL 原样保留。

# 输出
直接输出润色后的正文。`;

interface MockChannel {
  id: number;
}

type Handler = (args: Record<string, unknown>) => unknown;

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character] ?? character;
  });
}

/** Install the stub on `window.__TAURI_INTERNALS__`. Idempotent. */
export function installTauriMock(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) return;

  const callbacks = new Map<number, (payload: unknown) => void>();
  const setupState = new URLSearchParams(window.location.search).get("setup");
  let nextCallbackId = 1;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const exampleAutomation = createMockAutomation();

  const state = {
    settings: {
      settingsVersion: 5,
      providers: [
        {
          id: "builtin-official",
          name: "Tietiezhi Gateway",
          type: "openai",
          baseUrl: "https://tietiezhi.vip/v1",
          builtIn: true,
          models: setupState === "no-model" ? [] : TERLN_MODELS,
        },
      ] as Provider[],
      chatProviderId: setupState === "ready" ? "builtin-official" : "",
      chatModel: setupState === "ready" ? "gpt-5.6-luna" : "",
      chatReasoningEffort: "auto",
      titleProviderId: "",
      titleModel: "",
      asrProviderId: "",
      asrModel: "",
      polishProviderId: "",
      polishModel: "",
      polishEnabled: true,
      outputLanguage: "auto",
      dictationHotkey: "Alt+Space",
      polishPrompt: "",
      systemPrompt: "",
      permissionMode: "auto",
      skillsDisabled: [] as string[],
      showMessageStats: false,
      showReasoning: false,
      smartSuggestionsEnabled: true,
      smartSuggestionsAllowPaidModels: false,
      mcpServers: [
        {
          id: "mcp-fs",
          name: "filesystem",
          enabled: true,
          transport: {
            kind: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            env: {},
          },
        },
      ],
    },
    agents: [
      {
        id: "agent-coder",
        name: "编码助手",
        systemPrompt: "你是一个专注写代码的助手。",
        model: "",
        modelProviderId: "",
        reasoningEffort: "",
        skills: [],
        mcpServers: [],
        tools: [],
        permissionMode: "auto",
      },
    ] as Record<string, unknown>[],
    skills: new Map<string, { description: string; body: string; enabled: boolean }>([
      [
        "pdf-tools",
        { description: "处理 PDF：拆分、合并、抽取文本", body: "# PDF 技能\n\n使用……", enabled: true },
      ],
    ]),
    keys: {} as Record<string, string>,
    projects: [
      {
        id: "project-tietiezhi",
        name: "Tietiezhi",
        rootPath: "/Users/demo/Projects/Tietiezhi",
        createdAt: Date.now() - 86_400_000,
        lastOpenedAt: Date.now(),
      },
      {
        id: "project-autobot",
        name: "autobot",
        rootPath: "/Users/demo/Projects/autobot",
        createdAt: Date.now() - 172_800_000,
        lastOpenedAt: Date.now() - 3_600_000,
      },
    ] as Record<string, unknown>[],
    deviceCores: [
      {
        id: "core-home",
        name: "家里的 Core",
        baseUrl: "http://192.168.1.20:8080",
        createdAt: Date.now() - 86_400_000,
        online: true,
        latencyMs: 18,
        deviceCount: 2,
        lastError: "",
        hasToken: true,
      },
    ] as DeviceCore[],
    devices: [
      {
        id: "local",
        nativeId: "local",
        name: "Tietiezhi MacBook",
        platform: "macos",
        coreId: "local",
        coreName: "软件内嵌 Core",
        role: "device",
        online: true,
        capabilities: [
          "system.status",
          "system.ping",
          "app.focus",
          "files.access",
          "terminal.execute",
          "browser.control",
        ],
      },
      {
        id: "core:core-home",
        nativeId: "core-home",
        name: "家里的 Core",
        platform: "core",
        coreId: "core-home",
        coreName: "家里的 Core",
        role: "core",
        online: true,
        capabilities: ["core.health", "core.devices"],
      },
      {
        id: "core-home/android-phone",
        nativeId: "android-phone",
        name: "Pixel 10 Pro",
        platform: "android",
        coreId: "core-home",
        coreName: "家里的 Core",
        role: "device",
        online: true,
        capabilities: [
          "system.status",
          "system.ping",
          "notification.send",
          "camera.capture",
          "location.read",
        ],
      },
    ] as TietiezhiDevice[],
    conversations: new Map<string, Record<string, unknown>>(),
    automations: new Map<string, AutomationDocument>([
      [exampleAutomation.id, exampleAutomation],
    ]),
    automationArchivedAt: new Map<string, number>(),
    suggestionDecks: new Map<string, Record<string, unknown>>(),
    cancelled: new Set<number>(),
  };

  const push = (channel: MockChannel, index: number, payload: Record<string, unknown>) =>
    callbacks.get(channel.id)?.({ index, ...payload });

  /** Stream `reply` character by character over a tauri Channel. */
  const stream = async (
    requestId: number,
    channel: MockChannel,
    reply: string,
    model = "mock-model",
  ) => {
    let i = 0;
    push(channel, i++, { message: { type: "started", model } });
    const reasoning = "让我想想用户到底想问什么。\n先拆解意图，再决定用什么结构回答，最后检查一遍。";
    for (const ch of reasoning) {
      if (state.cancelled.has(requestId)) break;
      push(channel, i++, { message: { type: "reasoning", content: ch } });
      await sleep(8);
    }
    for (const ch of reply) {
      if (state.cancelled.has(requestId)) break;
      push(channel, i++, { message: { type: "delta", content: ch } });
      await sleep(12);
    }
    push(channel, i++, {
      message: {
        type: "usage",
        promptTokens: 28,
        completionTokens: Math.ceil(reply.length / 3),
        totalTokens: 28 + Math.ceil(reply.length / 3),
        cachedTokens: 0,
      },
    });
    push(channel, i++, {
      message: { type: "done", cancelled: state.cancelled.has(requestId) },
    });
    push(channel, i, { end: true });
    state.cancelled.delete(requestId);
  };

  const streamCreateVideo = async (
    requestId: number,
    channel: MockChannel,
    request: {
      providerId?: string;
      model?: string;
      durationSeconds?: number;
    },
  ) => {
    let index = 0;
    const emit = (message: Record<string, unknown>) =>
      push(channel, index++, { message });
    const providerId = request.providerId || "builtin-official";
    const model = request.model || "agnes-video-v2.0";
    emit({ type: "started", providerId, model });
    for (const progress of [8, 18, 34, 52, 71, 88, 96]) {
      if (state.cancelled.has(requestId)) {
        emit({ type: "cancelled" });
        push(channel, index, { end: true });
        state.cancelled.delete(requestId);
        return;
      }
      emit({ type: "progress", progress, status: "processing" });
      await sleep(180);
    }
    emit({
      type: "completed",
      result: {
        providerId,
        model,
        filePath: "",
        mimeType: "video/mp4",
        durationSeconds: Number(request.durationSeconds) || 5,
      },
    });
    push(channel, index, { end: true });
  };

  /** Scripted agent turn: text → tool call → permission ask → result → text. */
  const streamAgentDemo = async (
    requestId: number,
    channel: MockChannel,
    model = "mock-model",
    taskMode: "work" | "code" = "code",
  ) => {
    let i = 0;
    const emit = (message: Record<string, unknown>) => push(channel, i++, { message });
    emit({ type: "started", model });
    for (const ch of "我来读取一下文件。") {
      emit({ type: "delta", content: ch });
      await sleep(20);
    }
    emit({ type: "toolCallStart", id: "call_1", name: "read_file", args: { path: "README.md" } });
    await sleep(600);
    emit({ type: "toolResult", id: "call_1", output: "    1\t# 铁铁汁\n    2\t演示内容", isError: false });
    if (taskMode === "work") {
      emit({
        type: "toolCallStart",
        id: "call_2",
        name: "write_file",
        args: { path: "成果摘要.md", content: "# 成果摘要" },
      });
      await sleep(400);
      emit({
        type: "toolResult",
        id: "call_2",
        output: "已写入成果摘要.md",
        isError: false,
      });
      for (const ch of "已完成资料整理，成果文件：`成果摘要.md`。") {
        emit({ type: "delta", content: ch });
        await sleep(20);
      }
      emit({
        type: "usage",
        promptTokens: 84,
        completionTokens: 26,
        totalTokens: 110,
        cachedTokens: 20,
      });
      emit({ type: "done", cancelled: state.cancelled.has(requestId) });
      push(channel, i, { end: true });
      state.cancelled.delete(requestId);
      return;
    }
    emit({
      type: "permissionRequest",
      id: "perm_1",
      tool: "bash",
      description: "执行命令：ls -la",
      args: { command: "ls -la" },
    });
    // Wait for permission_respond (or cancel).
    pendingPermission = null;
    for (let t = 0; t < 600; t++) {
      if (pendingPermission != null || state.cancelled.has(requestId)) break;
      await sleep(100);
    }
    const decision = pendingPermission ?? "deny";
    emit({ type: "toolCallStart", id: "call_2", name: "bash", args: { command: "ls -la" } });
    await sleep(400);
    emit(
      decision === "deny"
        ? { type: "toolResult", id: "call_2", output: "用户拒绝了此操作", isError: true }
        : { type: "toolResult", id: "call_2", output: "total 8\ndrwxr-xr-x  demo", isError: false },
    );
    for (const ch of "已完成：文件读取成功" + (decision === "deny" ? "，命令被拒绝。" : "，命令执行完毕。")) {
      emit({ type: "delta", content: ch });
      await sleep(20);
    }
    emit({ type: "usage", promptTokens: 96, completionTokens: 31, totalTokens: 127, cachedTokens: 24 });
    emit({ type: "done", cancelled: state.cancelled.has(requestId) });
    push(channel, i, { end: true });
    state.cancelled.delete(requestId);
  };
  const streamRetryDemo = async (
    requestId: number,
    channel: MockChannel,
    model = "mock-model",
  ) => {
    let i = 0;
    const emit = (message: Record<string, unknown>) => push(channel, i++, { message });
    emit({ type: "started", model });
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (state.cancelled.has(requestId)) break;
      emit({
        type: "retrying",
        attempt,
        maxRetries: 5,
        delayMs: 800,
        reason: "服务暂时不可用（503）",
      });
      await sleep(500);
    }
    if (state.cancelled.has(requestId)) {
      emit({ type: "done", cancelled: true });
    } else {
      emit({
        type: "error",
        message: "模型服务暂时不可用",
        detail:
          '模型服务返回 HTTP 503\n\n{\n  "error": {\n    "code": "do_request_failed",\n    "message": "所有节点均失败：上游服务暂时不可用"\n  }\n}',
        code: "do_request_failed",
        status: 503,
        retryable: true,
        retries: 5,
      });
    }
    push(channel, i, { end: true });
    state.cancelled.delete(requestId);
  };
  let pendingPermission: string | null = null;
  let gatewayLoggedIn = false;

  const handlers: Record<string, Handler> = {
    // --- Automation ---
    list_automations: (a) =>
      [...state.automations.values()]
        .map((automation) =>
          automationMeta(
            automation,
            state.automationArchivedAt.get(automation.id) ?? 0,
          ),
        )
        .filter((meta) => Boolean(a.includeArchived) || meta.archivedAt === 0)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    load_automation: (a) => {
      const automation = state.automations.get(a.id as string);
      if (!automation) throw "Automation 不存在或已被删除";
      return structuredClone(automation);
    },
    create_automation: (a) => {
      const timestamp = Date.now();
      const automation: AutomationDocument = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        name: String(a.name ?? "").trim() || "未命名自动化",
        description: "",
        revision: 0,
        nodes: [
          {
            id: crypto.randomUUID(),
            type: "manualTrigger",
            typeVersion: 1,
            name: "手动触发",
            position: { x: 96, y: 180 },
            disabled: false,
            config: {},
            inputs: {},
          },
        ],
        edges: [],
        settings: {
          timezone: "Asia/Shanghai",
          maxDurationMs: 300_000,
          maxConcurrency: 4,
          onMissedSchedule: "skip",
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.automations.set(automation.id, automation);
      return structuredClone(automation);
    },
    save_automation: (a) => {
      const automation = structuredClone(a.automation as AutomationDocument);
      if (!state.automations.has(automation.id)) {
        throw "Automation 不存在或已被删除";
      }
      const issues = validateMockAutomation(automation, false);
      if (issues[0]) throw issues[0].message;
      automation.name = automation.name.trim() || "未命名自动化";
      automation.updatedAt = Date.now();
      state.automations.set(automation.id, automation);
      return structuredClone(automation);
    },
    validate_automation: (a) =>
      validateMockAutomation(
        a.automation as AutomationDocument,
        Boolean(a.publish),
      ),
    archive_automation: (a) => {
      const automation = state.automations.get(a.id as string);
      if (!automation) throw "Automation 不存在或已被删除";
      const archivedAt = a.archived ? Date.now() : 0;
      state.automationArchivedAt.set(automation.id, archivedAt);
      return automationMeta(automation, archivedAt);
    },
    delete_automation: (a) => {
      state.automationArchivedAt.delete(a.id as string);
      state.automations.delete(a.id as string);
    },

    // --- Agents / skills / MCP / workspace ---
    list_agents: () => structuredClone(state.agents),
    upsert_agent: (a) => {
      const agent = structuredClone(a.agent as { id: string });
      const i = state.agents.findIndex((x) => x.id === agent.id);
      if (i >= 0) state.agents[i] = agent;
      else state.agents.push(agent);
    },
    delete_agent: (a) => {
      state.agents = state.agents.filter((x) => x.id !== a.id);
    },
    list_builtin_tools: () => [
      "read_file",
      "write_file",
      "edit_file",
      "list_dir",
      "glob",
      "grep",
      "bash",
      "fetch",
      "skill",
      "device_call",
    ],
    list_skills: () =>
      [...state.skills.entries()].map(([name, s]) => ({
        name,
        description: s.description,
        enabled: s.enabled,
      })),
    read_skill: (a) => {
      const s = state.skills.get(a.name as string);
      if (!s) throw `技能 ${String(a.name)} 不存在`;
      return `---\nname: ${String(a.name)}\ndescription: ${s.description}\n---\n\n${s.body}`;
    },
    upsert_skill: (a) => {
      const prev = state.skills.get(a.name as string);
      state.skills.set(a.name as string, {
        description: a.description as string,
        body: a.body as string,
        enabled: prev?.enabled ?? true,
      });
    },
    delete_skill: (a) => state.skills.delete(a.name as string),
    set_skill_enabled: (a) => {
      const s = state.skills.get(a.name as string);
      if (s) s.enabled = a.enabled as boolean;
    },
    import_skill: () => ({ name: "imported-skill", description: "导入的技能", enabled: true }),
    mcp_server_status: () =>
      state.settings.mcpServers.map((s) => ({
        id: s.id,
        state: s.enabled ? "running" : "stopped",
        toolCount: 0,
        error: "",
      })),
    mcp_restart_server: () => {},
    mcp_stop_server: () => {},
    pick_workspace_dir: () => "/Users/demo/Projects/example",
    pick_chat_files: (a) => {
      const image = Boolean(a.imagesOnly);
      const asset: ChatAttachment = image
        ? {
            id: crypto.randomUUID(),
            kind: "image",
            name: "preview.svg",
            mimeType: "image/svg+xml",
            path: "/Users/demo/Desktop/preview.svg",
            size: 238,
            dataUrl:
              "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='200'%3E%3Crect width='100%25' height='100%25' fill='%2322c55e'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' fill='white' font-size='28'%3ETietiezhi%3C/text%3E%3C/svg%3E",
          }
        : {
            id: crypto.randomUUID(),
            kind: "file",
            name: "requirements.md",
            mimeType: "text/markdown",
            path: "/Users/demo/Desktop/requirements.md",
            size: 84,
            textContent: "# Requirements\n\n- Unified attachment button\n- Asset cards",
          };
      return [asset];
    },
    pick_chat_folder: () => [
      {
        id: crypto.randomUUID(),
        kind: "folder",
        name: "design-assets",
        mimeType: "application/x-directory",
        path: "/Users/demo/Desktop/design-assets",
        size: 0,
        textContent: "README.md\nimages/\nimages/hero.png\nnotes.txt",
      } satisfies ChatAttachment,
    ],
    inspect_chat_asset_paths: () => [],
    list_projects: () =>
      structuredClone(state.projects).sort(
        (a, b) => (b.lastOpenedAt as number) - (a.lastOpenedAt as number),
      ),
    add_project: (a) => {
      const path = a.path as string;
      const existing = state.projects.find((project) => project.rootPath === path);
      if (existing) {
        existing.lastOpenedAt = Date.now();
        return structuredClone(existing);
      }
      const project = {
        id: crypto.randomUUID(),
        name: path.split(/[\\/]/).filter(Boolean).pop() ?? "项目",
        rootPath: path,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      };
      state.projects.unshift(project);
      return structuredClone(project);
    },
    touch_project: (a) => {
      const project = state.projects.find((item) => item.id === a.id);
      if (!project) throw "项目不存在或已被移除";
      project.lastOpenedAt = Date.now();
      return structuredClone(project);
    },
    rename_project: (a) => {
      const project = state.projects.find((item) => item.id === a.id);
      if (!project) throw "项目不存在或已被移除";
      const name = String(a.name).trim();
      if (!name) throw "项目名称不能为空";
      project.name = name;
      return structuredClone(project);
    },
    reveal_project: () => {},
    project_recommendations: (a) =>
      structuredClone(
        state.suggestionDecks.get(`${String(a.projectId ?? "standalone")}:${String(a.taskMode)}`) ?? null,
      ),
    refresh_project_recommendations: async (a) => {
      if (!state.settings.smartSuggestionsEnabled) return null;
      const key = `${String(a.projectId ?? "standalone")}:${String(a.taskMode)}`;
      const existing = state.suggestionDecks.get(key);
      if (existing && !a.force) return structuredClone(existing);
      await sleep(900);
      const project = state.projects.find((item) => item.id === a.projectId);
      const name = project ? String(project.name) : "最近工作";
      const code = a.taskMode !== "work";
      const technologies = project?.name === "Tietiezhi"
        ? ["Rust", "TypeScript", "React", "Tauri"]
        : project
          ? ["TypeScript", "Node.js"]
          : [];
      const deck = {
        projectId: String(a.projectId ?? ""),
        taskMode: code ? "code" : "work",
        generatedAt: Date.now(),
        model: "mock-suggestion-model",
        tokenUsage: 428,
        technologies,
        suggestions: code
          ? [
              {
                id: crypto.randomUUID(),
                title: project ? `梳理 ${name} 架构` : "回顾近期工作",
                description: project
                  ? `识别 ${technologies.join("、")} 的模块边界与开发路径。`
                  : "从近期任务中识别值得继续推进的方向。",
                prompt: `分析 ${name} 的技术栈、架构和关键模块，说明主要数据流与模块职责，输出结构化概览，并通过现有文档和代码交叉验证结论。`,
                category: "explore",
              },
              {
                id: crypto.randomUUID(),
                title: "审查本地改动",
                description: "检查正确性、回归风险以及缺失的验证。",
                prompt: `审查 ${name} 当前的本地代码改动，定位正确性问题和回归风险，直接修复明确问题，并运行最相关的检查与测试验证结果。`,
                category: "quality",
              },
              {
                id: crypto.randomUUID(),
                title: "运行项目检查",
                description: "执行类型检查、Rust 测试和前端构建。",
                prompt: `识别并运行 ${name} 适用的类型检查、静态检查和测试，修复本次发现的问题，最后汇总执行命令、结果和剩余风险。`,
                category: "test",
              },
              {
                id: crypto.randomUUID(),
                title: "检查 CI 一致性",
                description: "对比自动化流程与本地开发命令。",
                prompt: `检查 ${name} 的 CI、TODO 和模块边界，对比本地命令与自动化流程，选择一个影响明确的问题完成修复并验证。`,
                category: "docs",
              },
            ]
          : [
              {
                id: crypto.randomUUID(),
                title: `生成 ${name} 概览`,
                description: "整理定位、架构、模块职责和关键流程。",
                prompt: `研究并整理 ${name} 的定位、架构、模块职责和关键流程，形成结构化项目概览，标明依据、未知项和建议的后续行动。`,
                category: "explore",
              },
              {
                id: crypto.randomUUID(),
                title: "核对文档与实现",
                description: "检查说明是否准确覆盖当前能力。",
                prompt: `检查 ${name} 的现有文档与实际实现是否一致，列出缺失、过时和容易误解的内容，并生成可直接采用的修订稿。`,
                category: "docs",
              },
              {
                id: crypto.randomUUID(),
                title: "梳理交付流程",
                description: "解读检查、构建、测试和发布链路。",
                prompt: `梳理 ${name} 的检查、测试、构建和发布流程，形成清晰的交付清单，指出关键依赖、薄弱环节和验证方式。`,
                category: "test",
              },
              {
                id: crypto.randomUUID(),
                title: "整理待办与风险",
                description: "按影响和优先级形成行动清单。",
                prompt: `分析 ${name} 的近期任务、待办和潜在风险，按影响和紧急程度分类，形成包含负责人建议、验收标准和下一步的行动清单。`,
                category: "quality",
              },
            ],
      };
      state.suggestionDecks.set(key, deck);
      return structuredClone(deck);
    },
    mark_project_suggestion_used: () => {
      // The production command records this for the next generation context.
    },
    permission_respond: (a) => {
      pendingPermission = a.decision as string;
    },
    default_system_prompt: () => "你是铁铁汁（Tietiezhi），一个运行在用户桌面上的智能体助手。……",

    // --- Tietiezhi device fabric ---
    list_device_cores: () => structuredClone(state.deviceCores),
    add_device_core: async (a) => {
      await sleep(450);
      const online = !String(a.baseUrl).includes("offline");
      const core: DeviceCore = {
        id: crypto.randomUUID(),
        name: String(a.name),
        baseUrl: String(a.baseUrl).replace(/\/$/, ""),
        createdAt: Date.now(),
        online,
        latencyMs: online ? 26 : undefined,
        deviceCount: 0,
        lastError: online ? "" : "模拟 Core 当前离线",
        hasToken: Boolean(a.accessToken),
      };
      state.deviceCores.push(core);
      state.devices.push({
        id: `core:${core.id}`,
        nativeId: core.id,
        name: core.name,
        platform: "core",
        coreId: core.id,
        coreName: core.name,
        role: "core",
        online,
        capabilities: ["core.health", "core.devices"],
      });
      return structuredClone(core);
    },
    remove_device_core: (a) => {
      state.deviceCores = state.deviceCores.filter((core) => core.id !== a.id);
      state.devices = state.devices.filter((device) => device.coreId !== a.id);
    },
    probe_device_core: (a) => {
      const core = state.deviceCores.find((candidate) => candidate.id === a.id);
      if (!core) throw "设备 Core 不存在";
      return structuredClone(core);
    },
    list_connected_devices: () => structuredClone(state.devices),
    invoke_device: async (a) => {
      await sleep(520);
      const device = state.devices.find((candidate) => candidate.id === a.deviceId);
      if (!device) throw "设备不存在或已经离线";
      if (!device.online) throw "目标设备当前离线";
      const capability = String(a.capability);
      if (!device.capabilities.includes(capability)) {
        throw `设备尚未声明能力：${capability}`;
      }
      const output = capability === "core.health"
        ? { online: true, latencyMs: 18, devices: 2 }
        : capability === "system.status"
          ? {
              name: device.name,
              platform: device.platform,
              battery: device.platform === "android" ? 82 : undefined,
              capabilities: device.capabilities,
              at: Date.now(),
            }
          : capability === "system.ping"
            ? { reply: "pong", at: Date.now() }
            : { accepted: true, capability, device: device.name };
      return {
        requestId: crypto.randomUUID(),
        deviceId: device.id,
        capability,
        ok: true,
        output,
        message: `“${device.name}”已完成调用`,
        durationMs: 42,
      };
    },

    load_settings: () => structuredClone(state.settings),
    save_settings: (a) => {
      state.settings = structuredClone(a.settings as typeof state.settings);
    },

    list_providers: () =>
      state.settings.providers.map((p) => ({
        ...structuredClone(p),
        hasKey: Boolean(state.keys[p.id]),
      })),
    provider_key: (a) => state.keys[a.id as string] ?? null,
    upsert_provider: (a) => {
      const provider = structuredClone(a.provider as Provider);
      const i = state.settings.providers.findIndex((p) => p.id === provider.id);
      if (i >= 0) state.settings.providers[i] = provider;
      else state.settings.providers.push(provider);
      if (a.apiKey) state.keys[provider.id] = a.apiKey as string;
    },
    delete_provider: (a) => {
      state.settings.providers = state.settings.providers.filter((p) => p.id !== a.id);
      delete state.keys[a.id as string];
    },
    fetch_provider_models: (a) => {
      const models = a.kind === "mimo" ? MIMO_MODELS : TERLN_MODELS;
      const provider = state.settings.providers.find((candidate) => candidate.id === a.id);
      if (provider) provider.models = structuredClone(models);
      return models;
    },
    gateway_account: (a) => ({
      providerId: String(a.providerId ?? "builtin-official"),
      supported: true,
      loggedIn: gatewayLoggedIn,
      account: gatewayLoggedIn
        ? {
            userId: 1,
            email: "demo@example.com",
            nickname: "Demo",
            avatar: "",
          }
        : undefined,
      expires: gatewayLoggedIn ? Date.now() + 30 * 24 * 60 * 60 * 1000 : undefined,
    }),
    gateway_login: (a) => {
      gatewayLoggedIn = true;
      return {
        providerId: String(a.providerId ?? "builtin-official"),
        supported: true,
        loggedIn: true,
        account: {
          userId: 1,
          email: "demo@example.com",
          nickname: "Demo",
          avatar: "",
        },
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
      };
    },
    gateway_logout: () => {
      gatewayLoggedIn = false;
    },
    gateway_quota: () => {
      if (!gatewayLoggedIn) throw "请先登录当前中转站";
      return {
        wallet: {
          balanceMicro: 8_620_000,
          frozenMicro: 0,
          totalTopupMicro: 10_000_000,
          totalSpendMicro: 1_380_000,
        },
        packages: [
          {
            id: 1,
            name: "新人首充包",
            status: "active",
            meterBy: "sale_amount",
            quotaPerWindow: 10_000_000,
            totalQuotaCap: 10_000_000,
            totalUsed: 1_380_000,
            windowRemaining: 8_620_000,
            validUntil: undefined,
          },
        ],
        recentConsumption: [
          {
            requestId: "req-demo-1",
            publicModel: "gpt-5.4",
            amountMicro: 120_000,
            userPackageId: 1,
            cardMeasure: 120_000,
            createdAt: new Date().toISOString(),
          },
        ],
        paymentChannels: { alipay: true, wechat: true },
      };
    },
    gateway_package_catalog: () => {
      if (!gatewayLoggedIn) throw "请先登录当前中转站";
      return {
        items: [
          {
            id: 6,
            name: "新人首充包",
            description: "¥6 得 ¥10，全模型通用，每人限购一次",
            meterBy: "sale_amount",
            quotaPerWindow: 10_000_000,
            validDays: 0,
            maxPurchasesPerUser: 1,
            priceMicro: 6_000_000,
          },
          {
            id: 7,
            name: "轻量包",
            description: "适合短期体验",
            meterBy: "sale_amount",
            quotaPerWindow: 35_000_000,
            validDays: 7,
            maxPurchasesPerUser: 0,
            priceMicro: 29_000_000,
          },
        ],
        paymentChannels: { alipay: true, wechat: true },
      };
    },
    gateway_create_package_order: (a) => ({
      orderNo: `TPMOCK${Date.now()}`,
      packageId: Number(a.packageId),
      packageName: Number(a.packageId) === 6 ? "新人首充包" : "轻量包",
      provider: String(a.paymentProvider),
      payAmountMicro: Number(a.packageId) === 6 ? 6_000_000 : 29_000_000,
      payAmountCny: Number(a.packageId) === 6 ? "6.00" : "29.00",
      paymentUrl: "https://example.test/desktop-payment/mock",
      status: 0,
    }),
    gateway_package_order_status: (a) => ({
      orderNo: String(a.orderNo),
      packageId: 6,
      provider: "alipay",
      payAmountMicro: 6_000_000,
      status: 1,
      paidAt: new Date().toISOString(),
      promotionStatus: "applied",
    }),
    generate_create_image: async (a) => {
      const request = a.request as {
        providerId?: string;
        model?: string;
        prompt?: string;
        resultCount?: number;
      };
      const prompt = String(request.prompt ?? "").trim();
      if (!prompt) throw "请先填写创意描述或图片节点指令";
      await sleep(650);
      const count = Math.min(4, Math.max(1, Number(request.resultCount) || 1));
      const providerId = request.providerId || "builtin-official";
      const model = request.model || "gpt-image-2";
      return Array.from({ length: count }, (_, index) => {
        const label = escapeXml(prompt.slice(0, 34));
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#172033"/><stop offset="1" stop-color="#66513d"/></linearGradient><linearGradient id="light" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#d3a86a"/><stop offset="1" stop-color="#f1dfbd"/></linearGradient></defs><rect width="1200" height="900" fill="url(#sky)"/><circle cx="930" cy="220" r="150" fill="#f3dfb3" opacity=".86"/><path d="M0 720L250 470L470 670L710 350L1200 760V900H0Z" fill="#20293a"/><path d="M0 790L360 570L610 760L870 520L1200 780V900H0Z" fill="url(#light)" opacity=".82"/><rect x="64" y="68" width="520" height="98" rx="20" fill="#0b101c" opacity=".72"/><text x="98" y="126" fill="#f8f4ec" font-family="sans-serif" font-size="31" font-weight="600">${label}</text><text x="99" y="151" fill="#c9c3b9" font-family="sans-serif" font-size="17">开发预览 ${index + 1} · ${escapeXml(model)}</text></svg>`;
        return {
          providerId,
          model,
          filePath: "",
          mimeType: "image/svg+xml",
          revisedPrompt: prompt,
          previewDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        };
      });
    },
    generate_create_video: (a) =>
      streamCreateVideo(
        a.requestId as number,
        a.onEvent as MockChannel,
        a.request as {
          providerId?: string;
          model?: string;
          durationSeconds?: number;
        },
      ),
    cancel_create_generation: (a) => state.cancelled.add(a.requestId as number),
    export_create_asset: (a) => a.filePath as string,
    delete_create_asset: () => {},

    tietiezhi_stream: (a) => {
      const messages = a.messages as {
        content: string | { type: string; text?: string }[];
      }[];
      const content = messages[messages.length - 1]?.content ?? "";
      const last =
        typeof content === "string"
          ? content
          : (content.find((part) => part.type === "text")?.text ?? "[附件]");
      return stream(
        a.requestId as number,
        a.onEvent as MockChannel,
        `收到。当前连接的是 ${String(a.deviceName)}。\n\n${last}`,
        "mock-tietiezhi",
      );
    },
    chat_stream: (a) => {
      if (a.contextAction === "inspect" || a.contextAction === "compact") {
        const channel = a.onEvent as MockChannel;
        const model = a.model as string;
        push(channel, 0, { message: { type: "started", model } });
        if (a.contextAction === "inspect") {
          push(channel, 1, {
            message: {
              type: "contextUsage",
              estimatedTokens: 48_320,
              contextWindow: 256 * 1024,
              compactAtTokens: Math.floor((256 * 1024 * 80) / 100),
            },
          });
        } else {
          push(channel, 1, {
            message: {
              type: "contextCompactionStarted",
              automatic: false,
              estimatedTokens: 48_320,
              contextWindow: 256 * 1024,
            },
          });
          push(channel, 2, {
            message: {
              type: "contextCompacted",
              automatic: false,
              summary: "## 目标\n- 继续当前工作区任务\n\n## 下一步\n1. 根据用户下一条消息继续",
              estimatedTokensBefore: 48_320,
              estimatedTokensAfter: 1_280,
              contextWindow: 256 * 1024,
            },
          });
        }
        push(channel, 3, { message: { type: "done", cancelled: false } });
        return;
      }
      const messages = a.messages as {
        content: string | { type: string; text?: string }[];
      }[];
      const content = messages[messages.length - 1]?.content ?? "";
      const last =
        typeof content === "string"
          ? content
          : (content.find((part) => part.type === "text")?.text ?? "[图片]");
      if (last.includes("标题生成测试")) {
        return stream(
          a.requestId as number,
          a.onEvent as MockChannel,
          "标题已经生成。",
          a.model as string,
        );
      }
      if (last.includes("错误重试")) {
        return streamRetryDemo(
          a.requestId as number,
          a.onEvent as MockChannel,
          a.model as string,
        );
      }
      // "工具" in the prompt exercises the agent-loop events (tool cards +
      // permission prompt) without a real model.
      if (last.includes("工具")) {
        return streamAgentDemo(
          a.requestId as number,
          a.onEvent as MockChannel,
          a.model as string,
          a.taskMode === "work" ? "work" : "code",
        );
      }
      // Markdown-shaped so the renderer (headings / lists / tables / fenced
      // code) can be exercised without a real model.
      const reply = `收到：**${last}**

## 小标题
- 列表项一，带 \`行内代码\`
- 第二项，含 [链接](https://tietiezhi.xyz)

\`\`\`java
public class Hello {
    public static void main(String[] args) {
        // 打印问候语
        System.out.println("你好，世界");
    }
}
\`\`\`

| 模型 | 类型 |
| --- | --- |
| gpt-5.5 | 对话 |
| mimo-v2.5-asr | 语音识别 |

> 引用：以上由 mock ${a.model} 生成。`;
      return stream(a.requestId as number, a.onEvent as MockChannel, reply, a.model as string);
    },
    chat_cancel: (a) => state.cancelled.add(a.requestId as number),
    polish_stream: (a) =>
      stream(
        a.requestId as number,
        a.onEvent as MockChannel,
        `（润色）${a.transcript}`,
        a.model as string,
      ),

    transcribe: () => "这是一段模拟的语音识别结果。",
    deliver_text: () => ({ inserted: false, needsAccessibility: false }),
    accessibility_trusted: () => true,
    default_polish_prompt: () => DEFAULT_PROMPT,
    dictation_hotkey: () => state.settings.dictationHotkey || "Alt+Space",
    set_dictation_hotkey: (a) => {
      state.settings.dictationHotkey = a.shortcut as string;
    },
    dictation_reset: () => {},
    dictation_toggle: () => {},

    hide_capsule: () => {},
    show_capsule: () => {},
    capsule_set_height: () => {},

    list_conversations: () =>
      [...state.conversations.values()]
        .filter((c) => !c.archivedAt)
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          projectId: c.projectId ?? "",
          taskMode: c.taskMode ?? "code",
          archivedAt: 0,
          pinnedAt: c.pinnedAt ?? 0,
        }))
        .sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number)),
    list_archived_conversations: () =>
      [...state.conversations.values()]
        .filter((c) => Boolean(c.archivedAt))
        .map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          projectId: c.projectId ?? "",
          taskMode: c.taskMode ?? "code",
          archivedAt: c.archivedAt,
          pinnedAt: c.pinnedAt ?? 0,
        }))
        .sort((a, b) => (b.archivedAt as number) - (a.archivedAt as number)),
    load_conversation: (a) => structuredClone(state.conversations.get(a.id as string)),
    save_conversation: (a) => {
      const conv = structuredClone(a.conversation as { id: string; title: string });
      const existing = state.conversations.get(conv.id);
      const updatedAt = Date.now();
      const existingTitle = existing?.title as string | undefined;
      const title =
        conv.title === "新会话" && existingTitle && existingTitle !== "新会话"
          ? existingTitle
          : conv.title;
      state.conversations.set(conv.id, {
        ...conv,
        title,
        updatedAt,
        archivedAt: existing?.archivedAt ?? 0,
        pinnedAt: existing?.pinnedAt ?? 0,
      });
      return { updatedAt, title };
    },
    generate_conversation_title: async (a) => {
      await sleep(350);
      const conversation = state.conversations.get(a.id as string);
      if (!conversation || conversation.title !== "新会话" || conversation.archivedAt) {
        return null;
      }
      const firstUser = String(a.userMessage ?? "");
      const title = firstUser.includes("标题生成") ? "配置 AI 会话标题" : "AI 生成的会话标题";
      conversation.title = title;
      return title;
    },
    delete_conversation: (a) => state.conversations.delete(a.id as string),
    archive_conversation: (a) => {
      const conversation = state.conversations.get(a.id as string);
      if (!conversation) throw "任务不存在";
      conversation.archivedAt = Date.now();
    },
    restore_conversation: (a) => {
      const conversation = state.conversations.get(a.id as string);
      if (!conversation) throw "任务不存在";
      conversation.archivedAt = 0;
    },
    set_conversation_pinned: (a) => {
      const conversation = state.conversations.get(a.id as string);
      if (!conversation) throw "任务不存在";
      const pinnedAt = a.pinned ? Date.now() : 0;
      conversation.pinnedAt = pinnedAt;
      return pinnedAt;
    },
    archive_project_conversations: (a) => {
      let count = 0;
      for (const conversation of state.conversations.values()) {
        if (conversation.projectId === a.projectId && !conversation.archivedAt) {
          conversation.archivedAt = Date.now();
          count += 1;
        }
      }
      return count;
    },
    task_workspace_overview: (a) => {
      const conversation = state.conversations.get(a.taskId as string);
      const initializedMode = conversation?.taskMode ?? "code";
      return {
        work: {
          mode: "work",
          initialized: initializedMode === "work" || Boolean(conversation),
          rootPath: "/mock/tasks/work",
          isGit: false,
          fileCount: 4,
          fileCountCapped: false,
          changedFiles: [],
          deliverables: [
            { path: "竞品调研.md", size: 8_420, modifiedAt: Date.now() },
            { path: "数据汇总.csv", size: 2_180, modifiedAt: Date.now() - 2_000 },
          ],
          transferableFiles: [
            { path: "竞品调研.md", size: 8_420, modifiedAt: Date.now() },
            { path: "数据汇总.csv", size: 2_180, modifiedAt: Date.now() - 2_000 },
          ],
        },
        code: {
          mode: "code",
          initialized: initializedMode === "code" || Boolean(conversation),
          rootPath: "/mock/tasks/code",
          isGit: true,
          fileCount: 128,
          fileCountCapped: false,
          changedFiles: ["src/App.tsx", "src/lib/task-mode.ts"],
          deliverables: [],
          transferableFiles: [
            { path: "src/App.tsx", size: 5_120, modifiedAt: Date.now() },
            {
              path: "src/lib/task-mode.ts",
              size: 1_280,
              modifiedAt: Date.now() - 1_000,
            },
          ],
        },
      };
    },
    transfer_task_workspace_file: (a) =>
      `.tietiezhi/imports/${String(a.fromMode)}/${String(a.path)}`,

    "plugin:app|version": () => "0.0.0-mock",
    "plugin:event|listen": () => 0,
    "plugin:event|unlisten": () => {},
  };

  w.__TAURI_INTERNALS__ = {
    transformCallback(callback: (payload: unknown) => void) {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    async invoke(cmd: string, args?: Record<string, unknown>) {
      await sleep(20);
      const handler = handlers[cmd];
      if (!handler) throw `mock: 未实现的命令 ${cmd}`;
      return handler(args ?? {});
    },
    metadata: {},
  };

  console.info("[dev] Tauri IPC mock 已启用（?mock）");
}
