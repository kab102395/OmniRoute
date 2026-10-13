import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openrouter-cost-"));
process.env.DATA_DIR = DATA_DIR;
process.env.OPENROUTER_CATALOG_TTL_MS = "900000";

const core = await import("../../src/lib/db/core.ts");
core.getDbInstance();
const settings = await import("../../src/lib/db/settings.ts");
const pricingSync = await import("../../src/lib/pricingSync.ts");
const { calculateCostWithEvidence, calculateModalCostWithEvidence } =
  await import("../../src/lib/usage/costCalculator.ts");
const { classifyCostAccounting } = await import("../../src/lib/usage/costAccounting.ts");

const routeId = "vendor/model-3";
const cachePath = path.join(DATA_DIR, "cache", "openrouter-catalog.json");

function writeCatalog(fetchedAt: string): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt,
      data: [
        {
          id: routeId,
          pricing: {
            prompt: "0.000001",
            completion: "0.000003",
            input_cache_read: "0.0000005",
            input_cache_write: "0.0000015",
            internal_reasoning: "0.000004",
            request: "0.0002",
          },
        },
        { id: "vendor/model-3:free", pricing: { prompt: "0", completion: "0" } },
      ],
    }),
    "utf8"
  );
}

test("OpenRouter estimates use exact route catalog rates instead of generic synced rates", async () => {
  writeCatalog(new Date().toISOString());
  pricingSync.saveSyncedPricing({
    openrouter: { [routeId]: { input: 100, output: 100 } },
  });

  const estimate = await calculateCostWithEvidence("openrouter", `openrouter/${routeId}`, {
    input: 1_000_000,
    output: 2_000_000,
  });

  assert.equal(estimate.costUsd, 7.0002);
  assert.equal(estimate.costKnown, true);
  assert.equal(estimate.pricingEvidence.source, "openrouter");
  assert.equal(estimate.pricingEvidence.modelId, routeId);
  assert.equal(estimate.pricingEvidence.stale, false);
  assert.equal(estimate.pricingEvidence.rateSources?.input?.source, "openrouter");
});

test("explicit OpenRouter pricing overrides avoid an unnecessary catalog refresh", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  await settings.updatePricing({
    openrouter: { [routeId]: { input: 0.5, output: 1 } },
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("catalog refresh should not be needed for an explicit override");
  };
  try {
    const estimate = await calculateCostWithEvidence("openrouter", routeId, {
      input: 1_000_000,
      output: 1_000_000,
    });
    assert.equal(estimate.costUsd, 1.5);
    assert.equal(estimate.costKnown, true);
    assert.equal(estimate.pricingEvidence.source, "user");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await settings.resetPricing("openrouter", routeId);
  }
});

test("stale OpenRouter rates remain estimates and cannot be marked known", async () => {
  const originalFetch = globalThis.fetch;
  writeCatalog(new Date(Date.now() - 30 * 60 * 1000).toISOString());
  globalThis.fetch = async () => {
    throw new Error("fixture upstream unavailable");
  };
  try {
    const estimate = await calculateCostWithEvidence("openrouter", routeId, {
      input: 1_000_000,
      output: 2_000_000,
    });
    assert.equal(estimate.costUsd, 7.0002);
    assert.equal(estimate.costKnown, false);
    assert.equal(estimate.pricingEvidence.source, "openrouter");
    assert.equal(estimate.pricingEvidence.stale, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter's dynamic free router is not estimated from a sibling route", async () => {
  writeCatalog(new Date().toISOString());
  pricingSync.clearSyncedPricing();
  const estimate = await calculateCostWithEvidence("openrouter", "free", {
    input: 1_000_000,
    output: 1_000_000,
  });
  assert.equal(estimate.costUsd, 0);
  assert.equal(estimate.costKnown, false);
  assert.equal(estimate.pricingEvidence.source, null);
});

test("an OpenRouter route missing from the exact catalog does not inherit generic synced rates", async () => {
  writeCatalog(new Date().toISOString());
  pricingSync.saveSyncedPricing({
    openrouter: { "vendor/unlisted-route": { input: 0.1, output: 0.2 } },
  });
  const estimate = await calculateCostWithEvidence("openrouter", "vendor/unlisted-route", {
    input: 100_000,
    output: 100_000,
  });
  assert.equal(estimate.costUsd, 0);
  assert.equal(estimate.costKnown, false);
  assert.equal(estimate.pricingEvidence.source, null);
});

test("OpenRouter media estimates stay unknown without authoritative unit-specific pricing", async () => {
  writeCatalog(new Date().toISOString());
  pricingSync.saveSyncedPricing({
    openrouter: { [routeId]: { output_cost_per_image: 0.03 } },
  });
  const estimate = await calculateModalCostWithEvidence("image", "openrouter", routeId, { n: 1 });
  assert.equal(estimate.costUsd, null);
  assert.equal(estimate.pricingEvidence.source, null);
});

test("a current exact free route is zero-cost even when numeric rates are absent", async () => {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), data: [{ id: "vendor/free:free" }] }),
    "utf8"
  );
  const estimate = await calculateCostWithEvidence("openrouter", "vendor/free:free", {
    input: 1_000_000,
    output: 1_000_000,
  });
  assert.equal(estimate.costUsd, 0);
  assert.equal(estimate.costKnown, true);
  assert.equal(estimate.pricingEvidence.source, "openrouter");
  assert.equal(
    estimate.pricingEvidence.condition,
    "OpenRouter currently advertises this exact route as free."
  );
  const accounting = classifyCostAccounting({
    provider: "openrouter",
    model: "vendor/free:free",
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    calculatedCostUsd: estimate.costUsd,
    calculatedCostKnown: estimate.costKnown,
    pricingEvidence: estimate.pricingEvidence,
  });
  assert.equal(accounting.kind, "estimated_cost");
  assert.equal(accounting.amountUsd, 0);
  assert.equal(accounting.source, "openrouter.models_api");
});

test("a stale exact free route stays unverified and is not described as currently free", async () => {
  const originalFetch = globalThis.fetch;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      data: [{ id: "vendor/stale-free:free" }],
    }),
    "utf8"
  );
  globalThis.fetch = async () => {
    throw new Error("catalog refresh unavailable");
  };

  try {
    const estimate = await calculateCostWithEvidence("openrouter", "vendor/stale-free:free", {
      input: 1_000_000,
      output: 1_000_000,
    });

    assert.equal(estimate.costUsd, 0);
    assert.equal(estimate.costKnown, false);
    assert.equal(estimate.pricingEvidence.stale, true);
    assert.match(estimate.pricingEvidence.condition || "", /last cached catalog/);
    assert.match(estimate.pricingEvidence.condition || "", /eligibility is unverified/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  pricingSync.clearSyncedPricing();
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.DATA_DIR;
  delete process.env.OPENROUTER_CATALOG_TTL_MS;
});
