import assert from "node:assert/strict";
import test from "node:test";

import { gatewayRoot, parseGatewayDiscovery } from "./gateway-protocol.js";

const discovery = {
  issuer: "https://gateway.example.test",
  authorization_endpoint: "https://gateway.example.test/desktop-authorize",
  token_endpoint: "https://gateway.example.test/native/token",
  session_endpoint: "https://gateway.example.test/native/session",
  revocation_endpoint: "https://gateway.example.test/native/revoke",
  client_id: "tietiezhi-desktop",
};

test("从 Provider v1 地址解析中转站根地址", () => {
  assert.equal(gatewayRoot("https://gateway.example.test/v1/"), "https://gateway.example.test");
});

test("接受同源的 Tietiezhi Gateway discovery", () => {
  assert.equal(
    parseGatewayDiscovery(discovery, "https://gateway.example.test").tokenEndpoint,
    discovery.token_endpoint,
  );
});

test("拒绝跨域登录端点", () => {
  assert.throws(
    () =>
      parseGatewayDiscovery(
        { ...discovery, token_endpoint: "https://evil.example.test/token" },
        "https://gateway.example.test",
      ),
    /不同源/,
  );
});
