/**
 * tests/unit/quota-store-pool-total.test.ts
 *
 * Coverage for QuotaStore.poolConsumedTotal():
 *   - Two keys in same pool → sum equals individual contributions.
 *   - Different pool or different dim → 0 (isolation).
 *   - peek() for a single key still returns only that key's own value (no regression).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pool-total-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");

async function resetStorage() {
  core.resetDbInstance();
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (fs.existsSync(TEST_DATA_DIR)) {
        fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      break;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if ((e?.code === "EBUSY" || e?.code === "EPERM") && attempt < 9) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ─── Main scenario: two keys in same pool ────────────────────────────────────

test("poolConsumedTotal: keyA(3) + keyB(2) in same pool → total === 5", async () => {
  const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
  const store = new SqliteQuotaStore();

  const dim = { poolId: "p1", unit: "requests" as const, window: "5h" as const };

  await store.consume("keyA", dim, 3);
  await store.consume("keyB", dim, 2);

  const total = await store.poolConsumedTotal("p1", dim);

  // Both consumes happen in the same bucket (milliseconds apart) so
  // prev=0, elapsed≈0 → total ≈ 5. Allow small delta for timing.
  assert.ok(total > 4.9, `Expected >4.9, got ${total}`);
  assert.ok(total <= 5, `Expected <=5, got ${total}`);
});

test("unknown USD usage is durable per key and visible to the whole pool", async () => {
  const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
  const { createPool } = await import("../../src/lib/db/quotaPools.ts");
  const store = new SqliteQuotaStore();
  const pool = createPool({
    connectionId: "c-unknown",
    name: "Unknown USD",
    allocations: [{ apiKeyId: "keyA", weight: 100, policy: "hard" }],
  });
  const dim = { poolId: pool.id, unit: "usd" as const, window: "daily" as const };

  assert.equal(await store.hasUnknownUsd("keyA", dim), false);
  assert.equal(await store.poolHasUnknownUsd(pool.id, dim), false);
  await store.markUnknownUsd("keyA", dim);
  assert.equal(await store.hasUnknownUsd("keyA", dim), true);
  assert.equal(await store.hasUnknownUsd("keyB", dim), false);
  assert.equal(await store.poolHasUnknownUsd(pool.id, dim), true);
  assert.equal(
    await store.poolHasUnknownUsd("other-pool", { ...dim, poolId: "other-pool" }),
    false
  );
  const snapshot = await store.poolUsageWithDimensions(pool.id, [
    { unit: "usd", window: "daily", limit: 10 },
  ]);
  assert.equal(snapshot.dimensions[0]?.unknownUsdUsage, true);
  await store.clear("keyA", dim);
  assert.equal(await store.poolHasUnknownUsd(pool.id, dim), false);
});

test("unknown USD markers stop blocking when their quota window expires", async () => {
  const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
  const store = new SqliteQuotaStore();
  const dim = { poolId: "p-expiry", unit: "usd" as const, window: "hourly" as const };
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    await store.markUnknownUsd("key-expiry", dim);
    assert.equal(await store.hasUnknownUsd("key-expiry", dim), true);
    now += 2 * 60 * 60 * 1000;
    assert.equal(await store.hasUnknownUsd("key-expiry", dim), false);
  } finally {
    Date.now = realNow;
  }
});

// ─── Isolation: different pool ───────────────────────────────────────────────

test("poolConsumedTotal: different poolId → returns 0 (isolation)", async () => {
  const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
  const store = new SqliteQuotaStore();

  const dimP1 = { poolId: "p1", unit: "requests" as const, window: "5h" as const };
  const dimP2 = { poolId: "p2", unit: "requests" as const, window: "5h" as const };

  await store.consume("keyA", dimP1, 10);

  // Pool p2 has no consumption → should be 0
  const total = await store.poolConsumedTotal("p2", dimP2);
  assert.equal(total, 0, `Expected 0 for different pool, got ${total}`);
});

// ─── Isolation: different dimension (unit) ───────────────────────────────────

test("poolConsumedTotal: different unit dim → returns 0 (isolation)", async () => {
  const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
  const store = new SqliteQuotaStore();

  const dimRequests = { poolId: "p1", unit: "requests" as const, window: "5h" as const };
  const dimTokens = { poolId: "p1", unit: "tokens" as const, window: "5h" as const };

  await store.consume("keyA", dimRequests, 7);

  // tokens dim has no consumption → should be 0
  const total = await store.poolConsumedTotal("p1", dimTokens);
  assert.equal(total, 0, `Expected 0 for different unit, got ${total}`);
});

// ─── No regression: peek still returns per-key value ─────────────────────────

test("poolConsumedTotal: peek(keyA) still returns only keyA's own consumption", async () => {
  const { SqliteQuotaStore } = await import("../../src/lib/quota/sqliteQuotaStore.ts");
  const store = new SqliteQuotaStore();

  const dim = { poolId: "p1", unit: "requests" as const, window: "5h" as const };

  await store.consume("keyA", dim, 3);
  await store.consume("keyB", dim, 2);

  const peekA = await store.peek("keyA", dim);

  // keyA's own peek should be ≈3, not 5
  assert.ok(peekA > 2.9, `Expected >2.9, got ${peekA}`);
  assert.ok(peekA <= 3, `Expected <=3, got ${peekA}`);
});
