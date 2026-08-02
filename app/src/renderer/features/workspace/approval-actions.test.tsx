import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalRecord } from "@shared/contracts";

import { ApprovalActions } from "./approval-actions";

const approval: ApprovalRecord = {
  id: "approval-1",
  runId: "run-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  toolCallId: "call-1",
  toolName: "writeFile",
  description: "写入 example.txt",
  input: { path: "example.txt" },
  risk: "medium",
  status: "pending",
  createdAt: 1,
  expiresAt: 2,
};

describe("ApprovalActions", () => {
  it("提交本轮允许决定", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    render(<ApprovalActions approval={approval} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "本轮不再询问" }));
    expect(onResolve).toHaveBeenCalledWith("approval-1", "allow-for-run");
  });

  it("提交失败后保留审批并展示错误", async () => {
    const onResolve = vi.fn().mockRejectedValue(new Error("审批请求已经结束"));
    render(<ApprovalActions approval={approval} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "允许一次" }));
    expect(await screen.findByText("审批请求已经结束")).toBeTruthy();
    expect((screen.getByRole("button", { name: "允许一次" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
