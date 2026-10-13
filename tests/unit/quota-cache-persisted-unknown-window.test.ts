import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-quota-unknown-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");
const quotaSnapshots = await import("../../src/lib/db/quotaSnapshots.ts");

test("unknown quota remains non-exhausted after cache hydration from persisted snapshot", () => {
  const connectionId = "unknown-quota-after-restart";
  quotaCache.__clearForTests();
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-tiered weekly": {
      remainingPercentage: 0,
      fractionReported: false,
      resetAt: "2026-01-08T00:00:00.000Z",
    },
  });
  quotaCache.setQuotaCache(connectionId, "antigravity", {
    "gemini-tiered weekly": {
      remainingPercentage: 0,
      fractionReported: false,
      resetAt: "2026-01-15T00:00:00.000Z",
    },
  });

  const saved = quotaSnapshots
    .getLatestQuotaSnapshotsForConnection(connectionId)
    .find((snapshot) => snapshot.windowKey === "gemini-tiered weekly");
  assert.ok(saved);
  assert.equal(saved.nextResetAt, "2026-01-15T00:00:00.000Z");
  assert.equal(saved.remainingPercentage, null);
  assert.equal(saved.fractionReported, 0);
  assert.equal(saved.isExhausted, 0);

  const resetEvent = coreDb
    .getDbInstance()
    .prepare(
      `SELECT previous_remaining_percentage, new_remaining_percentage,
              previous_used_percentage, new_used_percentage
       FROM provider_quota_reset_events WHERE connection_id = ?`
    )
    .get(connectionId) as Record<string, number | null> | undefined;
  assert.deepEqual(resetEvent, {
    previous_remaining_percentage: null,
    new_remaining_percentage: null,
    previous_used_percentage: null,
    new_used_percentage: null,
  });

  quotaCache.__clearForTests();
  assert.equal(quotaCache.isAccountQuotaExhausted(connectionId), false);
  assert.equal(
    quotaCache.getQuotaCache(connectionId)?.quotas["gemini-tiered weekly"].fractionReported,
    false
  );
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
