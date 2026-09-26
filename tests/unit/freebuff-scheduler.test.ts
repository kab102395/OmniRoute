import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-freebuff-scheduler-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getCredentialHealth } = await import("../../src/lib/credentialHealth/cache.ts");
const { sweep } = await import("../../src/lib/credentialHealth/scheduler.ts");

const originalFetch = globalThis.fetch;

test.beforeEach(async () => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("scheduled Freebuff validation retains account restriction warning without admission", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "freebuff",
    authType: "apikey",
    name: "scheduled-country-blocked",
    apiKey: "test-token",
    testStatus: "active",
    isActive: true,
  });
  assert.ok(connection?.id);

  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method || "GET" });
    return Response.json({ status: "country_blocked", countryCode: "US" }, { status: 403 });
  }) as typeof fetch;

  await sweep();

  assert.deepEqual(requests, [
    { url: "https://codebuff.com/api/v1/freebuff/session", method: "GET" },
  ]);
  const health = getCredentialHealth(connection.id);
  assert.equal(health?.status, "active", "valid auth remains healthy for credential tracking");
  assert.match(String(health?.warning), /country_blocked/);
});
