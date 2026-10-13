import assert from "node:assert/strict";
import test from "node:test";
import { addProviderLimitsFreshness } from "../../src/lib/usage/providerLimitsCache.ts";

const CACHE_ENTRY = {
  quotas: { daily: { remaining: 4 } },
  plan: "free",
  message: null,
  fetchedAt: "2026-10-13T12:00:00.000Z",
  source: "provider_api",
};

test("provider-limits API freshness reports age within the sync interval", () => {
  const caches = addProviderLimitsFreshness(
    { connection: CACHE_ENTRY },
    60_000,
    Date.parse("2026-10-13T12:00:30.000Z")
  );

  assert.equal(caches.connection.freshness.status, "fresh");
  assert.equal(caches.connection.freshness.ageMs, 30_000);
  assert.equal(caches.connection.freshness.maxAgeMs, 60_000);
  assert.equal(caches.connection.source, "provider_api");
});

test("provider-limits API freshness marks over-interval observations stale", () => {
  const caches = addProviderLimitsFreshness(
    { connection: CACHE_ENTRY },
    60_000,
    Date.parse("2026-10-13T12:01:00.001Z")
  );

  assert.deepEqual(caches.connection.freshness, {
    status: "stale",
    ageMs: 60_001,
    maxAgeMs: 60_000,
  });
});

test("provider-limits API freshness marks invalid or future timestamps unknown", () => {
  const caches = addProviderLimitsFreshness(
    {
      invalid: { ...CACHE_ENTRY, fetchedAt: "not-a-date" },
      future: { ...CACHE_ENTRY, fetchedAt: "2026-10-13T12:01:00.000Z" },
    },
    60_000,
    Date.parse("2026-10-13T12:00:00.000Z")
  );

  for (const connection of Object.values(caches)) {
    assert.deepEqual(connection.freshness, { status: "unknown", ageMs: null, maxAgeMs: 60_000 });
  }
});
