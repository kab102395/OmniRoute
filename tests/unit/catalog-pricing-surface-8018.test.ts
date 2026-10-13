import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { enrichCatalogModelEntry } from "../../src/lib/modelMetadataRegistry.ts";
import {
  saveModelsDevPricing,
  clearModelsDevPricing,
  type PricingByProvider,
} from "../../src/lib/modelsDevSync.ts";

type CatalogPricing = {
  input?: number;
  output?: number;
  cached?: number;
  cache_creation?: number;
};

describe("catalog pricing surface (#8018)", () => {
  before(() => {
    const pricing: PricingByProvider = {
      openai: {
        "gpt-4o": { input: 2.5, output: 10 },
        "whisper-1": { input: 0.006, output: 0 },
      },
    };
    saveModelsDevPricing(pricing);
  });

  after(() => {
    try {
      clearModelsDevPricing();
    } catch {
      // ignore
    }
  });

  it("attaches models.dev pricing onto catalog entries", () => {
    const entry = enrichCatalogModelEntry({
      id: "openai/gpt-4o",
      owned_by: "openai",
      root: "gpt-4o",
    });
    assert.ok(entry.pricing);
    assert.equal((entry.pricing as CatalogPricing).input, 2.5);
    assert.equal((entry.pricing as CatalogPricing).output, 10);
  });

  it("attaches specialty pricing when present", () => {
    const entry = enrichCatalogModelEntry({
      id: "openai/whisper-1",
      owned_by: "openai",
      root: "whisper-1",
      type: "audio",
      subtype: "transcription",
    });
    assert.ok(entry.pricing);
    assert.equal((entry.pricing as CatalogPricing).input, 0.006);
  });

  it("omits pricing when unknown", () => {
    const entry = enrichCatalogModelEntry({
      id: "unknown/provider-model-xyz",
      owned_by: "unknown",
      root: "provider-model-xyz",
    });
    assert.equal(entry.pricing, undefined);
  });

  it("does not replace explicit route pricing uncertainty with generic model pricing", () => {
    const entry = enrichCatalogModelEntry({
      id: "openai/gpt-4o",
      owned_by: "openai",
      root: "gpt-4o",
      pricing_provenance: { state: "incomplete", source: { id: "route-catalog" } },
    });
    assert.equal(entry.pricing, undefined);
    assert.deepEqual(entry.pricing_provenance, {
      state: "incomplete",
      source: { id: "route-catalog" },
    });
  });

  it("surfaces current provider pricing schedule and route uncertainty for native DeepSeek", () => {
    const flash = enrichCatalogModelEntry({
      id: "deepseek/deepseek-flash",
      owned_by: "deepseek",
      root: "deepseek-flash",
    });
    assert.deepEqual(flash.pricing, {
      input: 0.3,
      output: 1.2,
      cached: 0.006,
      reasoning: 1.2,
      cache_creation: 0.3,
    });
    assert.equal(
      (flash.pricing_provenance as { state?: string }).state,
      "conditional_reported_pricing"
    );
    assert.equal((flash.pricing_provenance as { rateUnit?: string }).rateUnit, "USD / 1M tokens");

    const pro = enrichCatalogModelEntry({
      id: "deepseek/deepseek-v4-pro",
      owned_by: "deepseek",
      root: "deepseek-v4-pro",
    });
    assert.equal(
      (pro.pricing_provenance as { state?: string }).state,
      "conditional_reported_pricing"
    );
    assert.equal(
      (pro.pricing_provenance as { resolvedModelId?: string }).resolvedModelId,
      "deepseek-flash"
    );
    assert.equal((pro.pricing as CatalogPricing).input, 0.3);
    assert.equal((pro.pricing as CatalogPricing).output, 1.2);
    assert.equal((pro.pricing as CatalogPricing).cached, 0.006);
    assert.equal(
      (pro.capabilities as Record<string, unknown>).vision,
      true,
      "the current V4.1-Flash route supports vision"
    );
    assert.equal((pro.capabilities as Record<string, unknown>).tool_calling, true);
    assert.match(
      (pro.pricing_provenance as { pricingCondition?: string }).pricingCondition || "",
      /until V4\.1-Pro launches/
    );
  });
});
