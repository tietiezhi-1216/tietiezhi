/**
 * End-to-end tests for the turn loop against a stub Anthropic endpoint.
 *
 * Run: node --test src/main/agent/loop.test.ts
 *
 * The stub speaks real Anthropic SSE rather than mocking our own provider layer,
 * so these tests cover the part most likely to break: the translation in
 * `provider.ts`. In particular they pin the thinking-signature round trip, which
 * is the defect that made the previous implementation fail Anthropic multi-turn
 * conversations after a tool call.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runTurn } from "./loop.js";
import { DEFAULT_TOOLS } from "./tools.js";

const run = runTurn;
const tools = DEFAULT_TOOLS;

/** One SSE frame in Anthropic's shape. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface StubTurn {
  /** Thinking text plus the signature the model would return with it. */
  thinking?: { text: string; signature: string };
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
}

/**
 * Serves one scripted response per request and records what it received, so a
 * test can assert on the *outbound* body — that is where a dropped signature
 * shows up.
 */
async function startStub(turns: StubTurn[]): Promise<{
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  let index = 0;

  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        requests.push({ unparsable: body });
      }

      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });

      let frames = sse("message_start", {
        type: "message_start",
        message: { id: "msg_stub", model: "claude-stub", usage: { input_tokens: 10 } },
      });

      let block = 0;
      if (turn?.thinking !== undefined) {
        frames += sse("content_block_start", {
          type: "content_block_start",
          index: block,
          content_block: { type: "thinking", thinking: "" },
        });
        frames += sse("content_block_delta", {
          type: "content_block_delta",
          index: block,
          delta: { type: "thinking_delta", thinking: turn.thinking.text },
        });
        frames += sse("content_block_delta", {
          type: "content_block_delta",
          index: block,
          delta: { type: "signature_delta", signature: turn.thinking.signature },
        });
        frames += sse("content_block_stop", { type: "content_block_stop", index: block });
        block += 1;
      }
      if (turn?.text !== undefined) {
        frames += sse("content_block_start", {
          type: "content_block_start",
          index: block,
          content_block: { type: "text", text: "" },
        });
        frames += sse("content_block_delta", {
          type: "content_block_delta",
          index: block,
          delta: { type: "text_delta", text: turn.text },
        });
        frames += sse("content_block_stop", { type: "content_block_stop", index: block });
        block += 1;
      }
      if (turn?.toolUse !== undefined) {
        frames += sse("content_block_start", {
          type: "content_block_start",
          index: block,
          content_block: { type: "tool_use", id: turn.toolUse.id, name: turn.toolUse.name, input: {} },
        });
        frames += sse("content_block_delta", {
          type: "content_block_delta",
          index: block,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.toolUse.input) },
        });
        frames += sse("content_block_stop", { type: "content_block_stop", index: block });
      }

      frames += sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: turn?.toolUse === undefined ? "end_turn" : "tool_use" },
        usage: { output_tokens: 7 },
      });
      frames += sse("message_stop", { type: "message_stop" });

      response.end(frames);
    });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function baseRequest(cwd: string, baseUrl: string) {
  return {
    model: {
      provider: "anthropic" as const,
      model: "claude-stub",
      apiKey: "test-key",
      baseUrl,
    },
    instructions: "你是测试助手",
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "开始" }] }],
    tools,
    maxSteps: 5,
    cwd,
  };
}

test("纯文本回复：一步结束，不触发审批", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  const stub = await startStub([{ text: "你好" }]);
  try {
    const events: string[] = [];
    const result = await run(
      baseRequest(cwd, stub.baseUrl),
      {
        emit: (event) => events.push(event.type),
        approve: async () => {
          throw new Error("不应该请求审批");
        },
      },
      new AbortController().signal,
    );

    assert.equal(result.reason, "stop");
    assert.equal(stub.requests.length, 1, "只应调用模型一次");
    assert.ok(events.includes("text-delta"));
    assert.ok(events.includes("turn-done"));
    assert.ok(!events.includes("approval-required"));
  } finally {
    await stub.close();
  }
});

test("thinking signature 原样回传给供应商", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "a.txt"), "原始内容", "utf8");
  // Step 1 thinks, then edits. Step 2 just answers, which is the request that
  // must carry step 1's signature back.
  const stub = await startStub([
    {
      thinking: { text: "先看文件", signature: "SIG_ABC123" },
      toolUse: { id: "call_1", name: "read", input: { path: "a.txt" } },
    },
    { text: "看完了" },
  ]);

  try {
    const result = await run(
      baseRequest(cwd, stub.baseUrl),
      { emit: () => {}, approve: async () => ({ outcome: "allow" }) },
      new AbortController().signal,
    );

    assert.equal(result.reason, "stop");
    assert.equal(stub.requests.length, 2, "工具结果应触发第二次调用");

    const replay = JSON.stringify(stub.requests[1]);
    assert.ok(
      replay.includes("SIG_ABC123"),
      "第二次请求必须带回 thinking signature，否则 Anthropic 会拒绝多轮对话",
    );
    assert.ok(replay.includes('"type":"thinking"'), "signature 必须挂在 thinking 块上");
  } finally {
    await stub.close();
  }
});

test("只读工具不问审批，写工具必须问", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "b.txt"), "旧", "utf8");
  const stub = await startStub([
    { toolUse: { id: "c1", name: "read", input: { path: "b.txt" } } },
    { toolUse: { id: "c2", name: "write", input: { path: "b.txt", content: "新" } } },
    { text: "完成" },
  ]);

  try {
    const asked: string[] = [];
    const result = await run(
      baseRequest(cwd, stub.baseUrl),
      {
        emit: () => {},
        approve: async (request) => {
          asked.push(request.toolName);
          return { outcome: "allow" };
        },
      },
      new AbortController().signal,
    );

    assert.equal(result.reason, "stop");
    assert.deepEqual(asked, ["write"], "只有写操作应触发审批");
    assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "新");
  } finally {
    await stub.close();
  }
});

test("拒绝审批时文件不被修改，且整轮结束", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "c.txt"), "不可改", "utf8");
  const stub = await startStub([
    { toolUse: { id: "c1", name: "write", input: { path: "c.txt", content: "被改了" } } },
    { text: "不该走到这里" },
  ]);

  try {
    const result = await run(
      baseRequest(cwd, stub.baseUrl),
      { emit: () => {}, approve: async () => ({ outcome: "deny", reason: "算了" }) },
      new AbortController().signal,
    );

    assert.equal(result.reason, "denied");
    assert.equal(await readFile(join(cwd, "c.txt"), "utf8"), "不可改", "拒绝后文件必须原样");
    assert.equal(stub.requests.length, 1, "拒绝后不应再调用模型");
  } finally {
    await stub.close();
  }
});

test("审批抛错按拒绝处理，不能默认放行", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "d.txt"), "安全", "utf8");
  const stub = await startStub([
    { toolUse: { id: "c1", name: "write", input: { path: "d.txt", content: "危险" } } },
  ]);

  try {
    const result = await run(
      baseRequest(cwd, stub.baseUrl),
      {
        emit: () => {},
        approve: async () => {
          throw new Error("UI 崩了");
        },
      },
      new AbortController().signal,
    );

    assert.equal(result.reason, "denied");
    assert.equal(await readFile(join(cwd, "d.txt"), "utf8"), "安全");
  } finally {
    await stub.close();
  }
});

test("路径穿越被拒绝", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  const stub = await startStub([
    { toolUse: { id: "c1", name: "read", input: { path: "../../../etc/passwd" } } },
    { text: "读不到" },
  ]);

  try {
    await run(
      baseRequest(cwd, stub.baseUrl),
      { emit: () => {}, approve: async () => ({ outcome: "allow" }) },
      new AbortController().signal,
    );

    const fed = JSON.stringify(stub.requests[1]);
    assert.ok(fed.includes("路径超出会话目录"), "越界路径必须报错回模型，而不是读到文件");
    assert.ok(!fed.includes("root:"), "不能出现 /etc/passwd 的内容");
  } finally {
    await stub.close();
  }
});

test("maxSteps 用尽时明确报告，而不是假装完成", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "e.txt"), "x", "utf8");
  // Always asks for a tool, so the loop can only end at the cap.
  const stub = await startStub([{ toolUse: { id: "c", name: "read", input: { path: "e.txt" } } }]);

  try {
    const request = { ...baseRequest(cwd, stub.baseUrl), maxSteps: 3 };
    const result = await run(
      request,
      { emit: () => {}, approve: async () => ({ outcome: "allow" }) },
      new AbortController().signal,
    );

    assert.equal(result.reason, "max-steps");
    assert.equal(stub.requests.length, 3, "应恰好用掉 maxSteps 次");
  } finally {
    await stub.close();
  }
});

test("取消后返回已产出的内容，不丢转写", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "f.txt"), "y", "utf8");
  const stub = await startStub([{ toolUse: { id: "c", name: "read", input: { path: "f.txt" } } }]);
  const controller = new AbortController();

  try {
    const result = await run(
      { ...baseRequest(cwd, stub.baseUrl), maxSteps: 4 },
      {
        emit: (event) => {
          // Cancel as soon as the first step's message lands.
          if (event.type === "message-done") controller.abort();
        },
        approve: async () => ({ outcome: "allow" }),
      },
      controller.signal,
    );

    assert.equal(result.reason, "cancelled");
    assert.ok(result.messages.length > 0, "取消也要保留已产出的消息");
  } finally {
    await stub.close();
  }
});

test("allow-always 后同一工具不再重复询问", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  const stub = await startStub([
    { toolUse: { id: "c1", name: "write", input: { path: "g1.txt", content: "1" } } },
    { toolUse: { id: "c2", name: "write", input: { path: "g2.txt", content: "2" } } },
    { text: "都写好了" },
  ]);

  try {
    let asked = 0;
    const result = await run(
      baseRequest(cwd, stub.baseUrl),
      {
        emit: () => {},
        approve: async () => {
          asked += 1;
          return { outcome: "allow-always" };
        },
      },
      new AbortController().signal,
    );

    assert.equal(result.reason, "stop");
    assert.equal(asked, 1, "第二次写入不应再问");
    assert.equal(await readFile(join(cwd, "g2.txt"), "utf8"), "2");
  } finally {
    await stub.close();
  }
});

test("edit 遇到多处匹配时报错而不是乱改", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tz-agent-"));
  await writeFile(join(cwd, "h.txt"), "同 同", "utf8");
  const stub = await startStub([
    { toolUse: { id: "c1", name: "edit", input: { path: "h.txt", oldText: "同", newText: "改" } } },
    { text: "需要更精确" },
  ]);

  try {
    await run(
      baseRequest(cwd, stub.baseUrl),
      { emit: () => {}, approve: async () => ({ outcome: "allow" }) },
      new AbortController().signal,
    );

    assert.equal(await readFile(join(cwd, "h.txt"), "utf8"), "同 同", "歧义时不能修改文件");
    assert.ok(JSON.stringify(stub.requests[1]).includes("出现 2 次"));
  } finally {
    await stub.close();
  }
});
