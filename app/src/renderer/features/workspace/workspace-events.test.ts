import { describe, expect, it } from "vitest";

import type { AppMessage, EngineEvent } from "@shared/contracts";

import { applyWorkspaceEvents } from "./workspace-events";

const message: AppMessage = {
  id: "message-1",
  conversationId: "conversation-1",
  role: "assistant",
  createdAt: 1,
  status: "streaming",
  parts: [
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "writeFile",
      input: { path: "example.txt" },
      status: "running",
    },
  ],
};

type EventInput = EngineEvent extends infer Event
  ? Event extends EngineEvent
    ? Omit<Event, "schemaVersion" | "runId" | "conversationId" | "createdAt">
    : never
  : never;

function event(value: EventInput): EngineEvent {
  return {
    schemaVersion: 1,
    runId: "run-1",
    conversationId: "conversation-1",
    createdAt: 2,
    ...value,
  } as EngineEvent;
}

describe("applyWorkspaceEvents", () => {
  it("审批请求和响应驱动统一消息状态", () => {
    const waiting = applyWorkspaceEvents([message], [
      event({
        type: "tool.approval_required",
        messageId: "message-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "writeFile",
        description: "写入 example.txt",
        input: { path: "example.txt" },
        risk: "medium",
        expiresAt: 100,
      }),
    ]);
    expect(waiting[0]?.status).toBe("waiting_approval");
    expect(waiting[0]?.parts[0]).toMatchObject({ status: "approval" });

    const resumed = applyWorkspaceEvents(waiting, [
      event({
        type: "tool.approval_resolved",
        messageId: "message-1",
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "writeFile",
        decision: "allow-once",
      }),
    ]);
    expect(resumed[0]?.status).toBe("streaming");
    expect(resumed[0]?.parts[0]).toMatchObject({ status: "running" });
  });

  it("重复工具结果不会产生重复记录", () => {
    const toolResult = event({
      type: "tool.result",
      messageId: "message-1",
      toolCallId: "call-1",
      toolName: "writeFile",
      output: { ok: true },
      isError: false,
    });
    const once = applyWorkspaceEvents([message], [toolResult]);
    const twice = applyWorkspaceEvents(once, [toolResult]);
    expect(twice[0]?.parts.filter((part) => part.type === "tool-result")).toHaveLength(1);
  });
});
