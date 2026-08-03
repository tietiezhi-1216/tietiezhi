import type { AppMessage, EngineEvent } from "@shared/contracts";

export function applyWorkspaceEvents(current: AppMessage[], events: EngineEvent[]): AppMessage[] {
  const next = [...current];
  const cloned = new Set<number>();
  for (const event of events) {
    const messageId = "messageId" in event ? event.messageId : "";
    const messageIndex = next.findIndex((message) => message.id === messageId);
    if (messageIndex < 0) continue;
    if (!cloned.has(messageIndex)) {
      const source = next[messageIndex];
      if (!source) continue;
      next[messageIndex] = { ...source, parts: [...source.parts] };
      cloned.add(messageIndex);
    }
    const message = next[messageIndex];
    if (!message) continue;
    if (event.type === "run.retrying") {
      message.status = "streaming";
    } else if (event.type === "run.retry.started") {
      message.parts = message.parts.filter(
        (part) => part.type !== "text" && part.type !== "reasoning",
      );
      message.firstTokenAt = undefined;
      message.completedAt = undefined;
      message.usage = undefined;
    } else if (event.type === "text.delta") {
      const index = message.parts.length - 1;
      const tail = message.parts[index];
      if (tail?.type === "text") message.parts[index] = { ...tail, text: tail.text + event.delta };
      else message.parts.push({ type: "text", text: event.delta });
      message.firstTokenAt ??= event.createdAt;
      message.status = "streaming";
    } else if (event.type === "text.end") {
      const streamedText = message.parts
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (streamedText === "" && event.text !== "") message.parts.push({ type: "text", text: event.text });
    } else if (event.type === "reasoning.delta") {
      const index = message.parts.length - 1;
      const tail = message.parts[index];
      if (tail?.type === "reasoning") message.parts[index] = { ...tail, text: tail.text + event.delta };
      else message.parts.push({ type: "reasoning", text: event.delta });
      message.status = "streaming";
    } else if (event.type === "tool.call") {
      const call = message.parts.find(
        (part) => part.type === "tool-call" && part.toolCallId === event.toolCallId,
      );
      if (call?.type === "tool-call") call.status = "running";
      else {
        message.parts.push({
          type: "tool-call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          status: "running",
        });
      }
      message.status = "streaming";
    } else if (event.type === "tool.approval_required") {
      message.status = "waiting_approval";
      message.parts = message.parts.map((part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId
          ? { ...part, status: "approval" }
          : part,
      );
    } else if (event.type === "tool.approval_resolved") {
      message.status = "streaming";
      message.parts = message.parts.map((part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId
          ? { ...part, status: event.decision === "deny" ? "denied" : "running" }
          : part,
      );
    } else if (event.type === "tool.result") {
      message.parts = message.parts.map((part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId
          ? { ...part, status: event.isError ? "failed" : "completed" }
          : part,
      );
      if (!message.parts.some((part) => part.type === "tool-result" && part.toolCallId === event.toolCallId)) {
        message.parts.push({
          type: "tool-result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
      }
    } else if (event.type === "artifact.diff") {
      message.parts.push({
        type: "diff",
        toolCallId: event.toolCallId,
        path: event.path,
        before: event.before,
        after: event.after,
        omitted: event.omitted,
        bytes: event.bytes,
      });
    } else if (event.type === "usage") {
      message.usage = event.usage;
    } else if (event.type === "run.completed") {
      message.status = event.finishReason === "cancelled" ? "cancelled" : "completed";
      message.completedAt = event.createdAt;
    } else if (event.type === "run.failed") {
      message.status = "failed";
      message.completedAt = event.createdAt;
      const duplicate = message.parts.some(
        (part) =>
          part.type === "error" &&
          part.code === event.error.code &&
          part.message === event.error.message,
      );
      if (!duplicate) {
        message.parts.push({ type: "error", code: event.error.code, message: event.error.message });
      }
    }
  }
  return cloned.size > 0 ? next : current;
}
