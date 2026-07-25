import type { ClientNotification } from "../typescript/ClientNotification";
import type { ClientRequest } from "../typescript/ClientRequest";
import type { ServerNotification } from "../typescript/ServerNotification";
import type { ServerRequest } from "../typescript/ServerRequest";

export const clientRequestFixture = {
  id: 1,
  method: "thread/list",
  params: {},
} satisfies ClientRequest;

export const clientNotificationFixture = {
  method: "initialized",
} satisfies ClientNotification;

export const serverRequestFixture = {
  id: "approval-1",
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1784970000000,
    environmentId: null,
    reason: "Command requires approval",
    command: "cargo test",
    cwd: "/workspace",
  },
} satisfies ServerRequest;

export const mcpElicitationRequestFixture = {
  id: "mcp-elicitation-1",
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-1",
    turnId: null,
    serverName: "example",
    mode: "form",
    _meta: null,
    message: "Provide a project name",
    requestedSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
      },
      required: ["name"],
    },
  },
} satisfies ServerRequest;

export const serverNotificationFixture = {
  method: "mcpServer/startupStatus/updated",
  params: {
    threadId: "thread-1",
    name: "expired-oauth",
    status: "failed",
    error: "OAuth credentials expired",
    failureReason: "reauthenticationRequired",
  },
} satisfies ServerNotification;
