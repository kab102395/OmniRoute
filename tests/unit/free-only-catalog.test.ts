import assert from "node:assert/strict";
import test from "node:test";
import {
  isExplicitOpenRouterFreeCatalogModel,
  isFreeOnlyCatalogModel,
} from "../../src/app/api/v1/models/freeOnlyCatalog.ts";

test("free-only catalog keeps only OpenRouter entries with verified zero-price state", () => {
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({
      id: "openrouter/google/gemma-4-31b-it:free",
      owned_by: "openrouter",
      free: true,
      route_availability: {
        source: {
          id: "openrouter.models_api",
          retrievedAt: new Date().toISOString(),
          cacheTtlMs: 900_000,
          stale: false,
        },
      },
    }),
    true
  );
  assert.equal(isExplicitOpenRouterFreeCatalogModel({ id: "openrouter/openai/gpt-5.5" }), false);
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({ id: "auto/coding:free", owned_by: "combo" }),
    false
  );
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({
      id: "openrouter/minimax/minimax-m3:free",
      owned_by: "openrouter",
      free: false,
      route_availability: {
        source: {
          id: "openrouter.models_api",
          retrievedAt: new Date().toISOString(),
          cacheTtlMs: 900_000,
          stale: false,
        },
      },
    }),
    false
  );
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({
      id: "openrouter/provider/model",
      owned_by: "openrouter",
      free: true,
      route_availability: {
        source: {
          id: "openrouter.models_api",
          retrievedAt: new Date().toISOString(),
          cacheTtlMs: 900_000,
          stale: false,
        },
      },
    }),
    true
  );
});

test("free-only catalog accepts exact provider routes with guaranteed hard stops", () => {
  assert.equal(
    isFreeOnlyCatalogModel({
      id: "groq/openai/gpt-oss-120b",
      root: "openai/gpt-oss-120b",
      owned_by: "groq",
      free_access: {
        classification: "documented_free_tier",
        hardStopGuaranteed: true,
        zeroCostOnExhaustion: "provider_hard_stop",
        source: { id: "omniroute.free_model_catalog" },
      },
    }),
    true
  );
  assert.equal(
    isFreeOnlyCatalogModel({
      id: "groq/provider/model",
      root: "provider/model",
      owned_by: "groq",
      free_access: {
        classification: "documented_free_tier",
        hardStopGuaranteed: false,
        zeroCostOnExhaustion: "not_guaranteed",
        source: { id: "omniroute.free_model_catalog" },
      },
    }),
    false
  );
});

test("free-only catalog accepts fresh exact provider free-route classifications", () => {
  const exactRoute = {
    id: "groq/llama/free-catalog-model",
    root: "llama/free-catalog-model",
    owned_by: "groq",
    free: true,
    free_route_provenance: {
      classification: "free",
      source: {
        id: "provider_model_catalog",
        modelId: "llama/free-catalog-model",
        retrievedAt: new Date().toISOString(),
        stale: false,
      },
    },
  };
  assert.equal(isFreeOnlyCatalogModel(exactRoute), true);
  assert.equal(
    isFreeOnlyCatalogModel({
      ...exactRoute,
      free_route_provenance: {
        ...exactRoute.free_route_provenance,
        source: { ...exactRoute.free_route_provenance.source, stale: true },
      },
    }),
    false
  );
  assert.equal(
    isFreeOnlyCatalogModel({
      ...exactRoute,
      free_route_provenance: {
        ...exactRoute.free_route_provenance,
        source: { ...exactRoute.free_route_provenance.source, modelId: "different/model" },
      },
    }),
    false
  );
  assert.equal(isFreeOnlyCatalogModel({ ...exactRoute, free: false }), false);
});

test("free-only catalog rejects provider free facts after their source freshness expires", () => {
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  assert.equal(
    isFreeOnlyCatalogModel({
      id: "provider/model",
      root: "model",
      owned_by: "provider",
      free: true,
      free_route_provenance: {
        classification: "free",
        source: {
          id: "provider_model_catalog",
          modelId: "model",
          retrievedAt: expired,
          stale: false,
        },
      },
    }),
    false
  );
});

test("free-only catalog rejects expired OpenRouter and Hugging Face route facts", () => {
  const openRouterRetrievedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  assert.equal(
    isFreeOnlyCatalogModel({
      id: "openrouter/provider/model:free",
      owned_by: "openrouter",
      free: true,
      route_availability: {
        source: {
          id: "openrouter.models_api",
          retrievedAt: openRouterRetrievedAt,
          cacheTtlMs: 15 * 60 * 1000,
          stale: false,
        },
      },
    }),
    false
  );

  assert.equal(
    isFreeOnlyCatalogModel({
      id: "hf/provider/model:route",
      root: "provider/model:route",
      owned_by: "huggingface",
      free: true,
      route_selection: { kind: "exact_model", exactModelIdentity: true },
      provider_routes_provenance: {
        source: "huggingface.router_models_api",
        retrieved_at: openRouterRetrievedAt,
        stale: false,
      },
      provider_routes: [
        {
          route_model: "hf/provider/model:route",
          status: "live",
          free_catalog_eligible: true,
        },
      ],
    }),
    false
  );
});
