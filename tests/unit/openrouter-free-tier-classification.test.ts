import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openrouter-tier-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "openrouter-tier-test-secret";

const freeWindow = await import("../../open-sse/services/openrouterFreeWindow.ts");
const quotaFetcher = await import("../../open-sse/services/openrouterQuotaFetcher.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providerLimitsDb = await import("../../src/lib/db/providerLimits.ts");
const providerLimits = await import("../../src/lib/usage/providerLimits.ts");
const coreDb = await import("../../src/lib/db/core.ts");

const originalFetch = globalThis.fetch;

function upstreamResponse(totalCredits: number | null, totalUsage: number | null): Response {
  return new Response(
    JSON.stringify({
      data: {
        total_credits: totalCredits,
        total_usage: totalUsage,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function keyResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        is_free_tier: false,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

async function resetStorage(): Promise<void> {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  freeWindow.clearFreeWindowState();
  await resetStorage();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("missing credits evidence keeps the conservative 50/day fallback", async () => {
  const connectionId = `missing-${Date.now()}`;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });

  await quotaFetcher.fetchOpenrouterQuota(connectionId, { apiKey: "test-key" });

  assert.equal(freeWindow.getFreeWindowStatus(`conn:${connectionId}`).dailyLimit, 50);
});

test("credits below the $10 threshold keep the 50/day tier", async () => {
  const connectionId = `below-${Date.now()}`;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/key") ? keyResponse() : upstreamResponse(9.99, 0);

  await quotaFetcher.fetchOpenrouterQuota(connectionId, { apiKey: "test-key" });

  assert.equal(freeWindow.getFreeWindowStatus(`conn:${connectionId}`).dailyLimit, 50);
});

test("qualifying cumulative credits synchronize the 1000/day tier", async () => {
  const connectionId = `qualifying-${Date.now()}`;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/key") ? keyResponse() : upstreamResponse(10, 0);

  await quotaFetcher.fetchOpenrouterQuota(connectionId, { apiKey: "test-key" });

  assert.equal(freeWindow.getFreeWindowStatus(`conn:${connectionId}`).dailyLimit, 1000);
});

test("manual provider-limit refresh persists the corrected free-tier quota", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: `OpenRouter tier ${Date.now()}`,
    apiKey: "test-key",
  });
  const connectionId = (connection as { id: string }).id;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/key") ? keyResponse() : upstreamResponse(10, 0);

  await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");

  const cached = providerLimitsDb.getProviderLimitsCache(connectionId);
  assert.equal(cached?.quotas?.free_daily?.total, 1000);
  assert.equal(cached?.quotas?.free_daily?.remaining, 1000);
});

test("failed OpenRouter refresh preserves the prior good provider-limit cache", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "openrouter",
    authType: "apikey",
    name: `OpenRouter failure ${Date.now()}`,
    apiKey: "test-key",
  });
  const connectionId = (connection as { id: string }).id;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/key") ? keyResponse() : upstreamResponse(10, 0);
  await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");
  const before = providerLimitsDb.getProviderLimitsCache(connectionId);

  quotaFetcher.invalidateOpenrouterQuotaCache(connectionId);
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  const result = await providerLimits.fetchAndPersistProviderLimits(connectionId, "manual");

  assert.deepEqual(result.cache, before);
  assert.equal(result.usage._stale, true);
  assert.equal(result.cache.quotas?.free_daily?.total, 1000);
});

test("quota refresh never logs the OpenRouter credential", async () => {
  const connectionId = `no-leak-${Date.now()}`;
  const secret = "sk-or-test-secret-must-not-appear";
  const logs: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await quotaFetcher.fetchOpenrouterQuota(connectionId, { apiKey: secret });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(
    logs.some((line) => line.includes(secret)),
    false
  );
});
