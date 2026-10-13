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
    "gemini-tiered": {
      remainingPercentage: 0,
      fractionReported: false,
      resetAt: null,
    },
  });

  const saved = quotaSnapshots.getLatestQuotaSnapshotsForConnection(connectionId)[0];
  assert.equal(saved.remainingPercentage, null);
  assert.equal(saved.fractionReported, 0);
  assert.equal(saved.isExhausted, 0);

  quotaCache.__clearForTests();
  assert.equal(quotaCache.isAccountQuotaExhausted(connectionId), false);
  assert.equal(
    quotaCache.getQuotaCache(connectionId)?.quotas["gemini-tiered"].fractionReported,
    false
  );
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
