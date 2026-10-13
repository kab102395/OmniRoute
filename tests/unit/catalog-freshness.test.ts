import assert from "node:assert/strict";
import test from "node:test";

import { boundRoutingCatalogCacheTtl } from "../../src/app/api/v1/models/catalogFreshness.ts";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const at = (ageMs: number) => new Date(now - ageMs).toISOString();

function responseBody(...models: Record<string, unknown>[]): string {
  return JSON.stringify({ object: "list", data: models });
}

test("ordinary catalog cache TTL is unchanged without routing constraints", () => {
  assert.equal(
    boundRoutingCatalogCacheTtl(responseBody(), "http://local/v1/models", 60_000, now),
    60_000
  );
});

test("free-only response cache expires with the current OpenRouter catalog", () => {
  const body = responseBody({
    id: "openrouter/vendor/model:free",
    owned_by: "openrouter",
    free: true,
    route_availability: {
      source: {
        id: "openrouter.models_api",
        retrievedAt: at(14 * 60_000),
        cacheTtlMs: 15 * 60_000,
        stale: false,
      },
    },
  });

  assert.equal(
    boundRoutingCatalogCacheTtl(body, "http://local/v1/models?free_only=true", 60_000, now),
    60_000
  );
  assert.equal(
    boundRoutingCatalogCacheTtl(body, "http://local/v1/models?free_only=true", 120_000, now),
    60_000
  );
  assert.equal(
    boundRoutingCatalogCacheTtl(
      body,
      "http://local/v1/models?free_only=true",
      120_000,
      now + 60_000
    ),
    0
  );
});

test("free-only response cache is bounded by synchronized provider catalog age", () => {
  const body = responseBody({
    id: "provider/model",
    owned_by: "provider",
    free: true,
    free_route_provenance: {
      classification: "free",
      source: {
        id: "provider_model_catalog",
        retrievedAt: at(23 * 60 * 60 * 1000),
        stale: false,
      },
    },
  });

  assert.equal(
    boundRoutingCatalogCacheTtl(
      body,
      "http://local/v1/models?free_only=true",
      2 * 60 * 60 * 1000,
      now
    ),
    60 * 60 * 1000
  );
});

test("tool-filtered response cache is bounded by capability source freshness", () => {
  const body = responseBody({
    id: "provider/tool-model",
    owned_by: "provider",
    capabilities: { tool_calling: true },
    capability_status: {
      tool_calling: {
        status: "supported",
        source: "openrouter.models_api",
        retrievedAt: at(14 * 60_000),
        stale: false,
      },
    },
  });

  assert.equal(
    boundRoutingCatalogCacheTtl(
      body,
      "http://local/v1/models?require_tool_calling=true",
      120_000,
      now + 60_000
    ),
    0
  );
});

test("stale and undated eligibility facts cannot keep a constrained response cached", () => {
  const body = responseBody(
    {
      id: "provider/stale-free",
      owned_by: "provider",
      free: true,
      free_route_provenance: {
        classification: "free",
        source: { id: "provider_model_catalog", retrievedAt: at(0), stale: true },
      },
    },
    {
      id: "openrouter/undated:free",
      owned_by: "openrouter",
      free: true,
      route_availability: {
        source: { id: "openrouter.models_api", stale: false, cacheTtlMs: 900_000 },
      },
    }
  );

  assert.equal(
    boundRoutingCatalogCacheTtl(body, "http://local/v1/models?free_only=true", 60_000, now),
    0
  );
});
