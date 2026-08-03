import assert from "node:assert/strict";
import test from "node:test";

import {
  GATEWAY_SCHEMA_VERSION,
  type GatewayDiscovery,
} from "@shared/gateway-protocol";

import { GatewayClient, parseGatewayDiscovery } from "./gateway-client.js";

const issuer = "https://gateway.example.com";

const discovery: GatewayDiscovery = {
  schema_version: GATEWAY_SCHEMA_VERSION,
  issuer,
  api_base: `${issuer}/v1`,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  bootstrap_endpoint: `${issuer}/v1/bootstrap`,
  models_endpoint: `${issuer}/v1/models`,
  authentication_methods: ["oauth_pkce", "api_key"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  native_clients: [{ client_id: "tietiezhi-desktop", redirect_uris: ["http://127.0.0.1/callback"] }],
};

const modelList = {
  schema_version: GATEWAY_SCHEMA_VERSION,
  object: "list",
  revision: "catalog-1",
  data: [{
    id: "tietiezhi/default",
    object: "model",
    display_name: "Tietiezhi Default",
    owned_by: "tietiezhi",
    created: 0,
    status: "available",
    capabilities: {
      input_modalities: ["text"],
      output_modalities: ["text"],
      streaming: true,
      tool_calling: true,
      structured_output: true,
      reasoning: true,
    },
    limits: { context_window: 128_000, max_output_tokens: 16_384 },
    supported_parameters: ["tools", "reasoning_effort"],
  }],
};

test("发现文档必须同源并同时声明登录与 API Key", () => {
  const parsed = parseGatewayDiscovery(discovery, issuer);
  assert.deepEqual(parsed.authentication_methods, ["oauth_pkce", "api_key"]);
  assert.throws(
    () => parseGatewayDiscovery({ ...discovery, models_endpoint: "https://evil.example/models" }, issuer),
    /不同源/,
  );
});

test("登录和 API Key 使用相同 Bootstrap JSON", async () => {
  const seenModes: string[] = [];
  const client = new GatewayClient(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const mode = headers.get("x-tietiezhi-auth-mode") ?? "";
    seenModes.push(mode);
    return Response.json({
      schema_version: GATEWAY_SCHEMA_VERSION,
      object: "gateway.bootstrap",
      issued_at: "2026-08-03T00:00:00Z",
      auth: { mode, subject: "subject-1", scopes: ["models:read", "responses:create"] },
      endpoints: { models: `${issuer}/v1/models`, responses: `${issuer}/v1/responses` },
      models: modelList,
    });
  });

  const login = await client.bootstrap(discovery, { mode: "login", secret: "access-token" });
  const apiKey = await client.bootstrap(discovery, { mode: "api_key", secret: "tz-key" });

  assert.equal(login.models.data[0]?.id, "tietiezhi/default");
  assert.equal(apiKey.models.data[0]?.id, "tietiezhi/default");
  assert.deepEqual(seenModes, ["login", "api_key"]);
});
