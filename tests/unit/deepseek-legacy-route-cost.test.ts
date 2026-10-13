import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-deepseek-route-cost-"));
process.env.DATA_DIR = DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { calculateCostWithEvidence } = await import("../../src/lib/usage/costCalculator.ts");

test("direct DeepSeek legacy V4-Pro id estimates at current V4.1-Flash peak rates", async () => {
  const estimate = await calculateCostWithEvidence("deepseek", "deepseek-v4-pro", {
    input: 1_000_000,
    output: 1_000_000,
  });

  assert.equal(estimate.costUsd, 1.5);
  assert.equal(estimate.costKnown, true);
  assert.equal(estimate.pricingEvidence.source, "deepseek");
  assert.equal(estimate.pricingEvidence.condition?.includes("bills it at Flash rates"), true);
  assert.equal(estimate.pricingEvidence.stale, false);
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.DATA_DIR;
});
