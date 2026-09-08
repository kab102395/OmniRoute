import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gateway-client-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const clients = await import("../../src/lib/db/gatewayClientCredentials.ts");

test.after(() => {
  try {
    core.resetDbInstance();
  } catch {}
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

test("gateway client credentials are one-time secrets with permitted scopes", () => {
  const { record, secret } = clients.createGatewayClient({
    name: "odysseus",
    scopes: ["models:list", "completion:create"],
  });
  assert.match(secret, /^ogc_live_/);
  assert.ok(record.id.startsWith("gwc_"));
  assert.deepEqual(record.scopes, ["models:list", "completion:create"]);
  assert.ok(clients.verifyGatewayClient(secret, "models:list"));
  assert.ok(clients.verifyGatewayClient(secret, "completion:create"));
});

test("invalid, missing, revoked, and rotated credentials fail closed", () => {
  const created = clients.createGatewayClient({ name: "lifecycle", scopes: ["models:list"] });
  assert.equal(clients.verifyGatewayClient("ogc_live_invalid", "models:list"), null);
  assert.equal(clients.verifyGatewayClient(null, "models:list"), null);
  assert.equal(clients.revokeGatewayClient(created.record.id), true);
  assert.equal(clients.verifyGatewayClient(created.secret, "models:list"), null);
  const rotated = clients.createGatewayClient({ name: "rotate", scopes: ["completion:create"] });
  const replacement = clients.rotateGatewayClient(rotated.record.id);
  assert.ok(replacement);
  assert.equal(clients.verifyGatewayClient(rotated.secret, "completion:create"), null);
  assert.ok(clients.verifyGatewayClient(replacement?.secret, "completion:create"));
});

test("forbidden scopes and normal metadata never expose secret or hash", () => {
  const { record, secret } = clients.createGatewayClient({
    name: "scope",
    scopes: ["models:list"],
  });
  assert.equal(clients.verifyGatewayClient(secret, "completion:create"), null);
  assert.equal(clients.authenticateGatewayClient(secret, "completion:create").kind, "insufficient");
  const listed = clients.listGatewayClients().find((x) => x.id === record.id);
  assert.ok(listed);
  assert.equal(JSON.stringify(listed).includes(secret), false);
  assert.equal(JSON.stringify(listed).includes("token_hash"), false);
  const row = core
    .getDbInstance()
    .prepare("SELECT token_hash FROM gateway_client_credentials WHERE id = ?")
    .get(record.id) as { token_hash: string };
  assert.notEqual(row.token_hash, secret);
  assert.equal(row.token_hash.length, 64);
});

test("scope mapping is restricted to models and completion endpoints", () => {
  assert.equal(clients.gatewayScopeForRequest("GET", "/api/v1/models"), "models:list");
  assert.equal(
    clients.gatewayScopeForRequest("POST", "/api/v1/chat/completions"),
    "completion:create"
  );
  assert.equal(clients.gatewayScopeForRequest("POST", "/api/v1/responses"), "completion:create");
  assert.equal(clients.gatewayScopeForRequest("DELETE", "/api/v1/models"), null);
  assert.equal(clients.gatewayScopeForRequest("GET", "/api/keys"), null);
});
