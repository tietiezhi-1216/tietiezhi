/**
 * Run with Node's built-in runner (type stripping is on by default in Node 22.18+/23.6+):
 *
 *   cd app && node --test src/main/config/projection.test.ts
 *
 * projection.ts is loaded through an absolute file URL because Node does not
 * resolve extensionless relative specifiers, and tsconfig forbids writing the
 * `.ts` extension in a static import.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServerDefinition } from "@shared/contracts";

type ProjectionModule = typeof import("./projection");

const projection = (await import(
  new URL("./projection.ts", import.meta.url).href
)) as ProjectionModule;

const { projectMcp, renderMcpConfig, stringifyToml, writeFileAtomic } = projection;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const stdioServer: McpServerDefinition = {
  id: "filesystem",
  name: "Filesystem",
  enabled: true,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    env: { LOG_LEVEL: "debug" },
  },
};

const httpServer: McpServerDefinition = {
  id: "stripe",
  name: "Stripe",
  enabled: true,
  transport: {
    type: "http",
    url: "https://mcp.stripe.com/",
    headers: { Authorization: "Bearer sk-test" },
  },
};

const disabledServer: McpServerDefinition = {
  id: "disabled-one",
  name: "Disabled",
  enabled: false,
  transport: { type: "stdio", command: "never-run", args: [] },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tietiezhi-projection-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseJsonFile(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function mcpServersOf(text: string): Record<string, Record<string, unknown>> {
  const servers = parseJsonFile(text)["mcpServers"];
  assert.ok(servers !== null && typeof servers === "object");
  return servers as Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// claude-json
// ---------------------------------------------------------------------------

test("claude-json renders stdio and http servers with an explicit type", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, ".claude.json");
    const result = await projectMcp([stdioServer, httpServer], "claude-json", target);

    assert.equal(result.format, "claude-json");
    assert.equal(result.coreId, "claude-code");
    assert.equal(result.path, target);
    assert.deepEqual(result.skipped, []);

    const servers = mcpServersOf(await readFile(target, "utf8"));
    assert.deepEqual(servers["filesystem"], {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { LOG_LEVEL: "debug" },
    });
    assert.deepEqual(servers["stripe"], {
      type: "http",
      url: "https://mcp.stripe.com/",
      headers: { Authorization: "Bearer sk-test" },
    });
  });
});

test("claude-json keeps unrelated keys the core wrote into the same file", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, ".claude.json");
    await writeFileAtomic(
      target,
      JSON.stringify({ numStartups: 7, mcpServers: { stale: { type: "stdio", command: "old" } } }),
    );

    await projectMcp([stdioServer], "claude-json", target);

    const root = parseJsonFile(await readFile(target, "utf8"));
    assert.equal(root["numStartups"], 7);
    assert.deepEqual(Object.keys(mcpServersOf(await readFile(target, "utf8"))), ["filesystem"]);
  });
});

test("claude-json skips servers whose name collides with a built-in", () => {
  const reserved: McpServerDefinition = {
    id: "computer-use",
    name: "Reserved",
    enabled: true,
    transport: { type: "stdio", command: "node", args: [] },
  };
  const rendered = renderMcpConfig([reserved, stdioServer], "claude-json");
  assert.equal(rendered.skipped.length, 1);
  assert.equal(rendered.skipped[0]?.id, "computer-use");
  assert.match(rendered.skipped[0]?.reason ?? "", /reserves/);
  assert.ok(rendered.text !== null);
  assert.deepEqual(Object.keys(mcpServersOf(rendered.text)), ["filesystem"]);
});

// ---------------------------------------------------------------------------
// gemini-json
// ---------------------------------------------------------------------------

test("gemini-json uses httpUrl for http servers and bare command for stdio", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "settings.json");
    const result = await projectMcp([stdioServer, httpServer], "gemini-json", target);

    assert.equal(result.coreId, "gemini");
    assert.deepEqual(result.skipped, []);

    const servers = mcpServersOf(await readFile(target, "utf8"));
    const stripeKeys = Object.keys(servers["stripe"] ?? {});
    const filesystemKeys = Object.keys(servers["filesystem"] ?? {});

    assert.deepEqual(servers["filesystem"], {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { LOG_LEVEL: "debug" },
    });
    // `url` would select the SSE transport, which is not what we mean.
    assert.deepEqual(servers["stripe"], {
      httpUrl: "https://mcp.stripe.com/",
      headers: { Authorization: "Bearer sk-test" },
    });
    assert.ok(!stripeKeys.includes("url"));
    // Gemini has no `type` discriminator; the field set picks the transport.
    assert.ok(!filesystemKeys.includes("type"));
  });
});

// ---------------------------------------------------------------------------
// codex-toml
// ---------------------------------------------------------------------------

test("codex-toml renders stdio servers with nested env tables", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "config.toml");
    const result = await projectMcp([stdioServer], "codex-toml", target);

    assert.equal(result.coreId, "codex");
    const text = await readFile(target, "utf8");
    assert.match(text, /^# Generated by Tietiezhi/);
    assert.ok(text.includes("[mcp_servers.filesystem]"));
    assert.ok(text.includes('command = "npx"'));
    assert.ok(
      text.includes('args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]'),
    );
    assert.ok(text.includes("[mcp_servers.filesystem.env]"));
    assert.ok(text.includes('LOG_LEVEL = "debug"'));
  });
});

test("codex-toml renders http servers as url plus http_headers", () => {
  const rendered = renderMcpConfig([httpServer], "codex-toml");
  assert.ok(rendered.text !== null);
  assert.ok(rendered.text.includes('url = "https://mcp.stripe.com/"'));
  assert.ok(rendered.text.includes("[mcp_servers.stripe.http_headers]"));
  assert.ok(rendered.text.includes('Authorization = "Bearer sk-test"'));
  // A codex entry must not mix transports.
  assert.ok(!rendered.text.includes("command ="));
});

test("toml serialiser escapes special characters and quotes non-bare keys", () => {
  const text = stringifyToml({
    mcp_servers: {
      "weird name.v2": {
        command: 'C:\\Program Files\\a"b"\\run.exe',
        args: ["line\nbreak", "tab\there", "del\u007f", "emoji 🚀"],
        env: { "KEY WITH SPACE": "back\\slash", CTRL: "\u0001" },
      },
    },
  });

  assert.ok(text.includes('[mcp_servers."weird name.v2"]'));
  assert.ok(text.includes('command = "C:\\\\Program Files\\\\a\\"b\\"\\\\run.exe"'));
  assert.ok(text.includes('args = ["line\\nbreak", "tab\\there", "del\\u007f", "emoji 🚀"]'));
  assert.ok(text.includes('"KEY WITH SPACE" = "back\\\\slash"'));
  assert.ok(text.includes('CTRL = "\\u0001"'));
  // Escapes must be literal backslash sequences, never raw control characters.
  assert.ok(!text.includes("\u0001"));
  assert.ok(!/\n\s*break/.test(text));
});

test("toml serialiser omits a parent header that has no scalars of its own", () => {
  const text = stringifyToml({ mcp_servers: { a: { command: "x" } } });
  assert.ok(!text.includes("[mcp_servers]\n"));
  assert.ok(text.startsWith("[mcp_servers.a]"));
});

// ---------------------------------------------------------------------------
// Shared selection rules
// ---------------------------------------------------------------------------

for (const format of ["claude-json", "codex-toml", "gemini-json"] as const) {
  test(`${format} never projects disabled servers`, () => {
    const rendered = renderMcpConfig([stdioServer, disabledServer], format);
    assert.ok(rendered.text !== null);
    assert.ok(!rendered.text.includes("disabled-one"));
    // Disabled is a user choice, not a failure to report.
    assert.deepEqual(rendered.skipped, []);
  });

  test(`${format} skips unrepresentable servers with a reason`, () => {
    const broken: McpServerDefinition[] = [
      {
        id: "no-command",
        name: "No command",
        enabled: true,
        transport: { type: "stdio", command: "   ", args: [] },
      },
      {
        id: "ws-only",
        name: "Websocket only",
        enabled: true,
        transport: { type: "http", url: "ws://example.com/mcp" },
      },
      {
        id: "garbage-url",
        name: "Garbage",
        enabled: true,
        transport: { type: "http", url: "not a url" },
      },
      stdioServer,
      { ...stdioServer, name: "Duplicate" },
    ];

    const rendered = renderMcpConfig(broken, format);
    const byId = new Map(rendered.skipped.map((entry) => [entry.id, entry.reason]));

    assert.equal(rendered.skipped.length, 4);
    assert.match(byId.get("no-command") ?? "", /empty command/);
    assert.match(byId.get("ws-only") ?? "", /http\(s\)/);
    assert.match(byId.get("garbage-url") ?? "", /malformed url/);
    assert.match(byId.get("filesystem") ?? "", /Duplicate server id/);

    assert.ok(rendered.text !== null);
    assert.ok(!rendered.text.includes("ws://example.com/mcp"));
    assert.ok(rendered.text.includes("filesystem"));
  });
}

test("format none writes nothing and reports every enabled server as skipped", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "unused.json");
    const result = await projectMcp([stdioServer, httpServer, disabledServer], "none", target);

    assert.equal(result.path, "");
    assert.deepEqual(
      result.skipped.map((entry) => entry.id),
      ["filesystem", "stripe"],
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

test("projectMcp rejects a relative target path", async () => {
  await assert.rejects(
    () => projectMcp([stdioServer], "claude-json", "relative/.claude.json"),
    /absolute path/,
  );
});

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

test("a failed write leaves the previous config intact and no temp files behind", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "config.toml");
    await projectMcp([stdioServer], "codex-toml", target);
    const before = await readFile(target, "utf8");

    // A directory cannot be renamed over a file: forces the rename to fail
    // after the temp file already holds the new content.
    await assert.rejects(() => writeFileAtomic(dir, "clobbered"));

    assert.equal(await readFile(target, "utf8"), before);
    assert.deepEqual(await readdir(dir), ["config.toml"]);
  });
});

test("concurrent projections leave a complete file, never a truncated one", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, ".claude.json");
    const many: McpServerDefinition[] = Array.from({ length: 200 }, (_, index) => ({
      id: `server-${String(index)}`,
      name: `Server ${String(index)}`,
      enabled: true,
      transport: { type: "stdio", command: "node", args: ["server.js", "x".repeat(200)] },
    }));

    await Promise.all([
      projectMcp(many, "claude-json", target),
      projectMcp(many, "claude-json", target),
      projectMcp(many, "claude-json", target),
    ]);

    const servers = mcpServersOf(await readFile(target, "utf8"));
    assert.equal(Object.keys(servers).length, 200);
    assert.deepEqual(await readdir(dir), [".claude.json"]);
  });
});
