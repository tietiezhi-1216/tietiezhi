/**
 * Session store tests.
 *
 * The behaviour worth pinning is what happens when writes go wrong: a torn
 * trailing line must cost one message, not the transcript, and a reasoning
 * signature must come back byte-identical or the provider rejects the replay.
 */

import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  appendMessage,
  createSession,
  deleteSession,
  deriveTitle,
  listSessions,
  loadSession,
  setSessionRoot,
} from "./store.js";
import type { Message } from "./types.js";

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tz-store-"));
  setSessionRoot(root);
  return root;
}

test("新建会话后能原样读回", async () => {
  await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work", title: "测试" });
  const loaded = await loadSession(meta.id);

  assert.ok(loaded !== null);
  assert.equal(loaded.meta.cwd, "/tmp/work");
  assert.equal(loaded.meta.title, "测试");
  assert.deepEqual(loaded.messages, []);
});

test("追加的消息按顺序读回", async () => {
  await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work" });
  for (const text of ["一", "二", "三"]) {
    await appendMessage(meta.id, { role: "user", content: [{ type: "text", text }] });
  }

  const loaded = await loadSession(meta.id);
  assert.equal(loaded?.messages.length, 3);
  assert.deepEqual(
    loaded?.messages.map((message) =>
      message.content[0]?.type === "text" ? message.content[0].text : "",
    ),
    ["一", "二", "三"],
  );
});

test("reasoning 的 providerData 逐字节保留", async () => {
  await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work" });
  // The exact shape the Anthropic provider produces, including a signature that
  // must survive the round trip unaltered.
  const message: Message = {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "想了一下",
        providerData: { anthropic: { signature: "SIG/with+base64==chars" } },
      },
      { type: "text", text: "结论" },
    ],
  };
  await appendMessage(meta.id, message);

  const loaded = await loadSession(meta.id);
  assert.deepEqual(loaded?.messages[0], message, "签名必须原样返回，否则供应商会拒绝重放");
});

test("尾部半截行只损失一条消息，不损失整份转写", async () => {
  const root = await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work" });
  await appendMessage(meta.id, { role: "user", content: [{ type: "text", text: "完好" }] });
  // Simulates a crash between the write and the newline.
  await appendFile(join(root, meta.id, "messages.jsonl"), '{"role":"user","content":[{"type":"te');

  const loaded = await loadSession(meta.id);
  assert.equal(loaded?.messages.length, 1, "完好的消息必须还在");
  assert.equal(
    loaded?.messages[0]?.content[0]?.type === "text"
      ? loaded.messages[0].content[0].text
      : "",
    "完好",
  );
});

test("形状不合法的条目被跳过而不是让整份加载失败", async () => {
  const root = await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work" });
  const log = join(root, meta.id, "messages.jsonl");
  await appendFile(log, `${JSON.stringify({ role: "system", content: [] })}\n`);
  await appendFile(log, `${JSON.stringify({ role: "user", content: "不是数组" })}\n`);
  await appendMessage(meta.id, { role: "user", content: [{ type: "text", text: "有效" }] });

  const loaded = await loadSession(meta.id);
  assert.equal(loaded?.messages.length, 1);
});

test("元数据损坏时返回 null 而不是抛错", async () => {
  const root = await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work" });
  await writeFile(join(root, meta.id, "session.json"), "{ 不是 json", "utf8");

  assert.equal(await loadSession(meta.id), null);
});

test("列表按更新时间倒序", async () => {
  await freshRoot();
  const first = await createSession({ cwd: "/a", title: "旧" });
  // `updatedAt` has millisecond resolution, and both writes can land inside the
  // same millisecond — which made this test flake, since the subject under test
  // *is* the ordering. Waiting past the tick is what makes the two timestamps
  // genuinely different rather than relying on how slow the machine is.
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await createSession({ cwd: "/b", title: "新" });
  assert.ok(second.updatedAt > first.updatedAt, "两条会话的时间戳必须不同，否则断言无意义");

  const list = await listSessions();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.id, second.id);
  assert.equal(list[1]?.id, first.id);
});

test("删除会话后读不到，重复删除返回 false", async () => {
  await freshRoot();
  const meta = await createSession({ cwd: "/tmp/work" });

  assert.equal(await deleteSession(meta.id), true);
  assert.equal(await loadSession(meta.id), null);
  assert.equal(await deleteSession(meta.id), false);
});

test("会话 id 里的路径穿越被拒绝", async () => {
  await freshRoot();
  await assert.rejects(() => loadSession("../../etc"), /不合法/);
  await assert.rejects(() => appendMessage("a/b", { role: "user", content: [] }), /不合法/);
});

test("标题取首条用户消息的第一行并截断", () => {
  assert.equal(
    deriveTitle([{ role: "user", content: [{ type: "text", text: "帮我改一下登录\n还有注册" }] }]),
    "帮我改一下登录",
  );
  const long = "很".repeat(60);
  const title = deriveTitle([{ role: "user", content: [{ type: "text", text: long }] }]);
  assert.equal(title?.length, 41, "超长标题截断到 40 字加省略号");
  assert.equal(deriveTitle([{ role: "assistant", content: [{ type: "text", text: "x" }] }]), null);
});
