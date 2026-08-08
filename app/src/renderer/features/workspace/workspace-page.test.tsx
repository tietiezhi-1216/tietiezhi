// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentDefinition, DesktopAPI, Message, Workspace } from "@shared/contracts";

import { WorkspacePage } from "./workspace-page";

function setupAPI() {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: () => undefined,
  });
  const workspace: Workspace = {
    id: "workspace-1",
    kind: "temporary",
    name: "新任务",
    path: "/tmp/tietiezhi/workspace-1",
    createdAt: 1,
    updatedAt: 1,
  };
  const conversation = {
    id: "conversation-1",
    workspaceId: workspace.id,
    title: "新对话",
    createdAt: 1,
    updatedAt: 1,
  };
  const agent: AgentDefinition = {
    id: "agent-1",
    name: "主理人",
    role: "任务协调",
    description: "协调任务",
    availability: "idle",
    isBuiltIn: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const userMessage: Message = {
    id: "message-1",
    conversationId: conversation.id,
    role: "user",
    status: "completed",
    parts: [{ type: "text", text: "你好" }],
    createdAt: 2,
    updatedAt: 2,
  };
  const api: DesktopAPI = {
    app: { setWindowMode: vi.fn(() => Promise.resolve()) },
    auth: {
      status: vi.fn(() => Promise.resolve({ authenticated: true })),
      openLogin: vi.fn(() => Promise.resolve({ authenticated: true })),
      cancelLogin: vi.fn(() => Promise.resolve()),
      loginWithAPIKey: vi.fn(() => Promise.resolve({ authenticated: true })),
      openRegistration: vi.fn(() => Promise.resolve()),
      logout: vi.fn(() => Promise.resolve()),
      setAvatar: vi.fn(() => Promise.resolve({ authenticated: true })),
    },
    workspaces: {
      list: vi.fn(() => Promise.resolve([])),
      chooseProject: vi.fn(() => Promise.resolve(null)),
      createTemporary: vi.fn(() => Promise.resolve(workspace)),
      reveal: vi.fn(() => Promise.resolve()),
      listDirectory: vi.fn(() => Promise.resolve([])),
      readTextFile: vi.fn(() => Promise.resolve("")),
    },
    conversations: {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.resolve({ conversation, workspace, messages: [] })),
      load: vi.fn(() => Promise.resolve({ conversation, workspace, messages: [] })),
      appendMessage: vi.fn(() => Promise.resolve(userMessage)),
      rename: vi.fn(() => Promise.resolve({ ...conversation, title: "你好" })),
      remove: vi.fn(() => Promise.resolve()),
    },
    agentProfiles: {
      list: vi.fn(() => Promise.resolve([agent])),
      presets: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.resolve(agent)),
    },
    agentGroups: {
      list: vi.fn(() => Promise.resolve([])),
      create: vi.fn(),
      remove: vi.fn(() => Promise.resolve()),
    },
    agents: {
      start: vi.fn(() => Promise.resolve({ conversationId: conversation.id, sessionId: "session-1", modelId: "model-1" })),
      prompt: vi.fn(() => Promise.resolve()),
      abort: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
      onEvent: vi.fn(() => () => undefined),
    },
  };
  window.tietiezhi = api;
  return { api, workspace };
}

describe("WorkspacePage 草稿会话", () => {
  it("点击新建任务不会创建 Workspace 或 Conversation", async () => {
    const { api } = setupAPI();
    render(
      <WorkspacePage
        auth={{ authenticated: true }}
        onAuthChange={() => undefined}
        onLogout={() => Promise.resolve()}
      />,
    );

    await waitFor(() => expect(api.workspaces.list).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "新建对话" })[0]!);

    expect(api.workspaces.createTemporary).not.toHaveBeenCalled();
    expect(api.conversations.create).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("发送消息给 Pi Agent…")).toBeTruthy();
  });

  it("首次发送时才创建临时 Workspace 和 Conversation", async () => {
    const { api } = setupAPI();
    render(
      <WorkspacePage
        auth={{ authenticated: true }}
        onAuthChange={() => undefined}
        onLogout={() => Promise.resolve()}
      />,
    );

    await waitFor(() => expect(api.agentProfiles.list).toHaveBeenCalled());
    fireEvent.click(screen.getAllByRole("button", { name: "新建对话" })[0]!);
    fireEvent.change(screen.getByPlaceholderText("发送消息给 Pi Agent…"), {
      target: { value: "你好" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(api.agents.prompt).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      text: "你好",
    }));
    expect(api.workspaces.createTemporary).toHaveBeenCalledOnce();
    expect(api.conversations.create).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
  });
});
