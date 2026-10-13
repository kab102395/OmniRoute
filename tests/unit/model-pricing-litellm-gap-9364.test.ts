import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  enrichCatalogModelEntry,
  type CatalogEnrichmentSnapshot,
} from "../../src/lib/modelMetadataRegistry.ts";
import {
  saveModelsDevPricing,
  clearModelsDevPricing,
  type PricingByProvider as ModelsDevPricingByProvider,
} from "../../src/lib/modelsDevSync.ts";
import {
  saveSyncedPricing,
  clearSyncedPricing,
  type PricingByProvider as SyncedPricingByProvider,
} from "../../src/lib/pricingSync.ts";

type CatalogPricing = {
  input?: number;
  output?: number;
  cached?: number;
  cache_creation?: number;
  output_cost_per_image?: number;
};

// #9364: resolveCatalogPricing() only consults models_dev_pricing and hardcoded
// defaults, skipping the LiteLLM `pricing_synced` namespace entirely. A model
// whose pricing exists ONLY in pricing_synced (the documented Layer 3) gets
// `pricing: null` in the /v1/models catalog. This test seeds pricing_synced
// with pricing for a model absent from both models_dev_pricing and hardcoded
// defaults, then asserts enrichCatalogModelEntry() surfaces it.

describe("catalog pricing LiteLLM gap (#9364)", () => {
  const snapshot: CatalogEnrichmentSnapshot = {
    modelsDevPricing: {
      openai: {
        "gpt-4o": { input: 2.5, output: 10 },
      },
    },
    pricingSourceStatus: {
      modelsDevRetrievedAt: "2026-10-12T10:00:00.000Z",
      modelsDevTtlMs: 86_400_000,
      liteLlmRetrievedAt: "2026-10-12T10:00:00.000Z",
      liteLlmTtlMs: 86_400_000,
    },
  };
  before(() => {
    // Seed ONLY the LiteLLM namespace with a model that is absent from both
    // models.dev and hardcoded defaults (babbage-002 is not in default-pricing
    // and not registered in the provider registry, so neither layer can match).
    const synced: SyncedPricingByProvider = {
      openai: {
        "babbage-002": { input: 0.4, output: 0.4 },
        "custom-image-rate": { output_cost_per_image: 0.04 },
      },
    };
    saveSyncedPricing(synced);

    // Ensure models_dev_pricing has a different model so we prove the LiteLLM
    // layer is being consulted, not accidentally overlapping with models.dev.
    const modelsDev: ModelsDevPricingByProvider = {
      openai: {
        "gpt-4o": { input: 2.5, output: 10 },
      },
    };
    saveModelsDevPricing(modelsDev);
  });

  after(() => {
    try {
      clearSyncedPricing();
      clearModelsDevPricing();
    } catch {
      // ignore
    }
  });

  it("attaches LiteLLM-synced pricing onto catalog entries absent from models.dev and defaults", () => {
    const entry = enrichCatalogModelEntry(
      {
        id: "openai/babbage-002",
        owned_by: "openai",
        root: "babbage-002",
      },
      undefined,
      snapshot
    );
    assert.ok(entry.pricing, "pricing should resolve from pricing_synced (LiteLLM) layer");
    assert.equal((entry.pricing as CatalogPricing).input, 0.4);
    assert.equal((entry.pricing as CatalogPricing).output, 0.4);
    const provenance = entry.pricing_provenance as {
      state: string;
      source: {
        id: string;
        retrievedAt: string;
        cacheTtlMs: number;
        ageMs: number;
        stale: boolean;
      };
      routeModelId: string;
      currency: string;
      rateUnit: string;
      authority: string;
    };
    assert.equal(provenance.state, "third_party_reported_pricing");
    assert.equal(provenance.source.id, "litellm.model_prices");
    assert.equal(provenance.source.retrievedAt, "2026-10-12T10:00:00.000Z");
    assert.equal(provenance.source.cacheTtlMs, 86_400_000);
    assert.ok(provenance.source.ageMs > 0);
    assert.equal(provenance.source.stale, false);
    assert.equal(provenance.routeModelId, "babbage-002");
    assert.equal(provenance.currency, "USD");
  });

  it("still resolves models.dev pricing when present (precedence preserved)", () => {
    const entry = enrichCatalogModelEntry(
      {
        id: "openai/gpt-4o",
        owned_by: "openai",
        root: "gpt-4o",
      },
      undefined,
      snapshot
    );
    assert.ok(entry.pricing);
    assert.equal((entry.pricing as CatalogPricing).input, 2.5);
    assert.equal((entry.pricing as CatalogPricing).output, 10);
    const provenance = entry.pricing_provenance as {
      state: string;
      source: { id: string; retrievedAt: string; stale: boolean };
    };
    assert.equal(provenance.state, "third_party_reported_pricing");
    assert.equal(provenance.source.id, "models_dev.api_json");
    assert.equal(provenance.source.retrievedAt, "2026-10-12T10:00:00.000Z");
    assert.equal(provenance.source.stale, false);
  });

  it("surfaces modality pricing without inventing token rates", () => {
    const entry = enrichCatalogModelEntry(
      {
        id: "openai/custom-image-rate",
        owned_by: "openai",
        root: "custom-image-rate",
      },
      undefined,
      snapshot
    );

    assert.equal((entry.pricing as CatalogPricing).output_cost_per_image, 0.04);
    assert.equal("input" in (entry.pricing as Record<string, unknown>), false);
    assert.equal("output" in (entry.pricing as Record<string, unknown>), false);
    const provenance = entry.pricing_provenance as { source: { id: string } };
    assert.equal(provenance.source.id, "litellm.model_prices");
  });

  it("marks synchronized rates stale after the source sync TTL", () => {
    const staleSnapshot: CatalogEnrichmentSnapshot = {
      modelsDevPricing: {},
      pricingSourceStatus: {
        modelsDevRetrievedAt: "2020-01-01T00:00:00.000Z",
        modelsDevTtlMs: 60_000,
        liteLlmRetrievedAt: "2020-01-01T00:00:00.000Z",
        liteLlmTtlMs: 60_000,
      },
    };
    const entry = enrichCatalogModelEntry(
      {
        id: "openai/babbage-002",
        owned_by: "openai",
        root: "babbage-002",
      },
      undefined,
      staleSnapshot
    );
    const provenance = entry.pricing_provenance as { source: { stale: boolean } };
    assert.equal(provenance.source.stale, true);
  });

  it("does not imply source or freshness for a pre-populated catalog price", () => {
    const entry = enrichCatalogModelEntry({
      id: "openai/gpt-4o",
      owned_by: "openai",
      root: "gpt-4o",
      pricing: { input: 2.5, output: 10 },
    });
    const provenance = entry.pricing_provenance as {
      state: string;
      source: { id: string; retrievedAt: string | null; stale: boolean | null };
    };
    assert.equal(provenance.state, "unverified_pricing");
    assert.equal(provenance.source.id, "catalog_entry.unattributed");
    assert.equal(provenance.source.retrievedAt, null);
    assert.equal(provenance.source.stale, null);
  });
});
