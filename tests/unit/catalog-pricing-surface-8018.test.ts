import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { enrichCatalogModelEntry } from "../../src/lib/modelMetadataRegistry.ts";
import { getDeepseekPricingEvidence } from "../../src/lib/catalog/deepseekPricing.ts";
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

  it("treats future-dated DeepSeek pricing evidence as stale", () => {
    const evidence = getDeepseekPricingEvidence(
      "deepseek-v4-pro",
      Date.parse("2026-10-13T00:00:00Z")
    );
    assert.equal(evidence?.source.stale, true);
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

  it("does not present direct DeepSeek API rates as Qoder route prices", () => {
    saveModelsDevPricing({
      deepseek: {
        "deepseek-v4-flash": { input: 0.3, output: 1.2, cached: 0.006 },
      },
    });

    const qoder = enrichCatalogModelEntry({
      id: "if/deepseek-v4-flash",
      owned_by: "if",
      root: "deepseek-v4-flash",
    });

    assert.equal(qoder.pricing, undefined);
    assert.equal(
      (qoder.pricing_provenance as { state?: string }).state,
      "unavailable",
      "the direct DeepSeek price source does not establish Qoder's account billing"
    );
  });

  it("keeps numeric pricing absent and marks pricing explicitly unavailable when unknown", () => {
    const entry = enrichCatalogModelEntry({
      id: "unknown/provider-model-xyz",
      owned_by: "unknown",
      root: "provider-model-xyz",
    });
    assert.equal(entry.pricing, undefined);
    assert.deepEqual(entry.pricing_provenance, {
      state: "unavailable",
      routeModelId: "provider-model-xyz",
      currency: "USD",
      source: { id: "omniroute.catalog_pricing_resolution", retrievedAt: null, stale: null },
      reason:
        "No matching provider pricing metadata was available from the configured catalog sources",
    });
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
    assert.equal(
      (pro.pricing_provenance as { servedModelVersion?: string }).servedModelVersion,
      "DeepSeek-V4.1-Flash"
    );
    assert.equal(
      (pro.pricing_provenance as { routeResolution?: { source?: { stale?: boolean } } })
        .routeResolution?.source?.stale,
      false
    );
    assert.equal(
      (
        pro.pricing_provenance as {
          routeResolution?: { source?: { url?: string; id?: string } };
        }
      ).routeResolution?.source?.url,
      "https://api-docs.deepseek.com/news/news260910/"
    );
    assert.deepEqual(
      (
        pro.pricing_provenance as {
          rates?: {
            inputCacheMiss?: { offPeak: string; peak: string };
            inputCacheHit?: { offPeak: string; peak: string };
            output?: { offPeak: string; peak: string };
          };
        }
      ).rates,
      {
        inputCacheMiss: { offPeak: "0.15", peak: "0.3" },
        inputCacheHit: { offPeak: "0.003", peak: "0.006" },
        output: { offPeak: "0.6", peak: "1.2" },
      }
    );
    assert.equal((pro.pricing as CatalogPricing).input, 0.3);
    assert.equal((pro.pricing as CatalogPricing).output, 1.2);
    assert.equal((pro.pricing as CatalogPricing).cached, 0.006);
    assert.equal((pro.capabilities as Record<string, unknown>).vision, true);
    assert.equal((pro.capabilities as Record<string, unknown>).structured_output, true);
    assert.ok((pro.input_modalities as string[]).includes("image"));
    assert.deepEqual(pro.output_modalities, ["text"]);
    assert.equal((pro.capabilities as Record<string, unknown>).tool_calling, true);
    assert.match(
      (pro.pricing_provenance as { pricingCondition?: string }).pricingCondition || "",
      /peak is 01:00-04:00 and 06:00-10:00 UTC Monday through Friday/
    );
  });

  it("replaces generic stale rates with current DeepSeek alias pricing provenance", () => {
    const entry = enrichCatalogModelEntry({
      id: "deepseek/deepseek-v4-pro",
      owned_by: "deepseek",
      root: "deepseek-v4-pro",
      pricing: { input: 9, output: 99, cached: 8 },
      pricing_provenance: {
        state: "third_party_reported_pricing",
        source: {
          id: "models_dev.api_json",
          retrievedAt: "2025-01-01T00:00:00.000Z",
          stale: true,
        },
      },
    });

    assert.deepEqual(entry.pricing, {
      input: 0.3,
      output: 1.2,
      cached: 0.006,
      reasoning: 1.2,
      cache_creation: 0.3,
    });
    assert.equal(
      (entry.pricing_provenance as { source?: { id?: string } }).source?.id,
      "deepseek.api_pricing"
    );
  });
});
