import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-provider-limits-route-auth-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "provider-limits-route-auth-test-secret";

const core = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/usage/provider-limits/route.ts");

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settings.updateSettings({ requireLogin: true, password: "configured-password" });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function unauthenticatedRequest(method: "GET" | "POST") {
  return new Request("https://external.example/api/usage/provider-limits", { method });
}

test("provider-limits GET requires management authentication when login is enabled", async () => {
  const response = await route.GET(unauthenticatedRequest("GET"));
  assert.equal(response.status, 401);
});

test("provider-limits POST requires management authentication before refreshing quotas", async () => {
  const response = await route.POST(unauthenticatedRequest("POST"));
  assert.equal(response.status, 401);
});

test("provider-limits GET remains available when login is disabled", async () => {
  await settings.updateSettings({ requireLogin: false });
  const response = await route.GET(unauthenticatedRequest("GET"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).caches, {});
});
