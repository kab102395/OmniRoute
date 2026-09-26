import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-freebuff-health-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const snapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");
const { isCredentialProbeInconclusive } =
  await import("../../src/lib/credentialHealth/probePolicy.ts");
const { isTerminalConnectionStatusValue } = await import("../../src/sse/services/auth.ts");

const originalFetch = globalThis.fetch;

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createFreebuffConnection(name: string) {
  const connection = await providersDb.createProviderConnection({
    provider: "freebuff",
    authType: "apikey",
    name,
    apiKey: `test-token-${name}`,
    testStatus: "active",
    isActive: true,
  });
  assert.ok(connection?.id);
  return connection as { id: string };
}

test.beforeEach(async () => {
  await resetStorage();
  globalThis.fetch = (async () =>
    Response.json({
      status: "none",
      freebucks: {
        balance: 0,
        quotaExempt: false,
        daily: { limit: 10, spent: 10, remaining: 0, resetAt: "2026-09-26T07:00:00Z" },
        wallet: { balance: 0, monthlyBonus: 0 },
        prices: { "deepseek/deepseek-v4-flash": 3 },
      },
    })) as typeof fetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("valid Freebuff auth with zero balance stays auth-valid and persists exhausted capacity", async () => {
  const connection = await createFreebuffConnection("empty-wallet");
  const result = await testSingleConnection(connection.id);
  assert.equal(result.valid, true);
  assert.equal(result.warning, null);
  const saved = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(saved.isActive, true);
  assert.equal(saved.testStatus, "active");
  const rows = snapshotsDb.getQuotaSnapshots({
    provider: "freebuff",
    connectionId: connection.id,
    since: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(rows.length, 1);
  const raw = JSON.parse(String(rows[0].rawData)) as {
    provenance: string;
    freebucks: { balance: number; capacity_by_model: Record<string, string> };
  };
  assert.equal(raw.provenance, "OBSERVED_UPSTREAM");
  assert.equal(raw.freebucks.balance, 0);
  assert.equal(raw.freebucks.capacity_by_model["deepseek/deepseek-v4-flash"], "exhausted");
});

test("valid Freebuff auth with country restriction remains visible to health checks but unroutable", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { status: "country_blocked", countryCode: "US" },
      { status: 403 }
    )) as typeof fetch;
  const connection = await createFreebuffConnection("country-blocked");
  const result = await testSingleConnection(connection.id);
  assert.equal(result.valid, true);
  assert.equal(result.accountState, "country_blocked");
  assert.match(String(result.warning), /country_blocked/);
  const saved = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(saved.isActive, true, "keep scheduled credential rechecks enabled");
  assert.equal(saved.testStatus, "country_blocked");
  assert.equal(isTerminalConnectionStatusValue(saved.testStatus), true);
});

test("Freebuff network outage remains inconclusive and does not poison credential health", async () => {
  globalThis.fetch = (async () => {
    throw new Error("test network unavailable");
  }) as typeof fetch;
  const connection = await createFreebuffConnection("network-outage");
  const result = await testSingleConnection(connection.id);
  assert.equal(result.valid, true);
  assert.equal(isCredentialProbeInconclusive(result), true);
  const saved = await providersDb.getProviderConnectionById(connection.id);
  assert.equal(saved.isActive, true);
  assert.equal(saved.testStatus, "active");
  assert.equal(saved.lastError ?? null, null);
});
