import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-partial-pricing-"));
process.env.DATA_DIR = DATA_DIR;
process.env.MODELS_DEV_SYNC_INTERVAL = "60";

const core = await import("../../../src/lib/db/core.ts");
const db = core.getDbInstance();
const settings = await import("../../../src/lib/db/settings.ts");
const { calculateCostWithEvidence } = await import("../../../src/lib/usage/costCalculator.ts");
const { classifyCostAccounting } = await import("../../../src/lib/usage/costAccounting.ts");

test("partial user pricing does not make a stale inherited rate count as known", async () => {
  const retrievedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    "models_dev_pricing",
    "mixed-source-provider",
    JSON.stringify({ "model-a": { input: 1, output: 2 } })
  );
  db.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    "models_dev_sync_status",
    "last_sync",
    JSON.stringify({
      lastSync: retrievedAt,
      sourceRetrievedAt: retrievedAt,
      modelCount: 1,
      capabilityCount: 0,
    })
  );
  await settings.updatePricing({
    "mixed-source-provider": { "model-a": { input: 0.5 } },
  });

  const estimate = await calculateCostWithEvidence("mixed-source-provider", "model-a", {
    input: 1_000_000,
    output: 1_000_000,
  });

  assert.equal(estimate.costUsd, 2.5);
  assert.equal(estimate.costKnown, false);
  assert.equal(estimate.pricingEvidence.source, "mixed");
  assert.equal(estimate.pricingEvidence.stale, true);
  assert.deepEqual(estimate.pricingEvidence.rateSources, {
    input: { source: "user", retrievedAt: null, ttlMs: null, stale: false },
    output: {
      source: "modelsDev",
      retrievedAt,
      ttlMs: 60_000,
      stale: true,
    },
  });

  const accounting = classifyCostAccounting({
    provider: "mixed-source-provider",
    model: "model-a",
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    calculatedCostUsd: estimate.costUsd,
    calculatedCostKnown: estimate.costKnown,
    pricingEvidence: estimate.pricingEvidence,
  });
  assert.equal(accounting.kind, "estimated_cost");
  assert.equal(accounting.source, "omniroute.mixed_pricing_sources");
  assert.equal(accounting.amountUsd, 2.5);
  assert.equal(accounting.pricingRetrievedAt, null);
  assert.equal(accounting.pricingStale, true);
  assert.deepEqual(accounting.pricingRateSources, estimate.pricingEvidence.rateSources);
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.MODELS_DEV_SYNC_INTERVAL;
});
