import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCostAccounting,
  classifyModalCostAccounting,
} from "../../src/lib/usage/costAccounting.ts";
import { resolveServedIdentity } from "../../open-sse/handlers/chatCore/servedIdentity.ts";
import { extractUsageFromResponse } from "../../open-sse/handlers/usageExtractor.ts";
import { extractUsage, normalizeUsage } from "../../open-sse/utils/usageTracking.ts";
import {
  buildCostPricingEvidence,
  computeCostFromPricing,
} from "../../src/lib/usage/costCalculator.ts";

test("pricing evidence treats future or incomplete timestamps as freshness unknown", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");
  const future = buildCostPricingEvidence(
    "modelsDev",
    "vendor/model",
    "2026-10-13T12:01:00.000Z",
    60_000,
    now
  );
  assert.equal(future.retrievedAt, "2026-10-13T12:01:00.000Z");
  assert.equal(future.stale, null);

  assert.equal(
    buildCostPricingEvidence("modelsDev", "vendor/model", "not-a-time", 60_000, now).stale,
    null
  );
  assert.equal(
    buildCostPricingEvidence("modelsDev", "vendor/model", "2026-10-13T11:59:30.000Z", 60_000, now)
      .stale,
    false
  );
  assert.equal(
    buildCostPricingEvidence("modelsDev", "vendor/model", "2026-10-13T11:00:00.000Z", 60_000, now)
      .stale,
    true
  );
});

test("served identity follows the final successful outbound model after fallback or retry", () => {
  assert.deepEqual(resolveServedIdentity("openai", { model: "provider-b/model-2" }), {
    provider: "openai",
    model: "provider-b/model-2",
    modelSource: "outbound_request",
    providerInstanceId: null,
  });
  assert.deepEqual(resolveServedIdentity("anthropic", { model: "claude-sonnet-4-6" }), {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    modelSource: "outbound_request",
    providerInstanceId: null,
  });
  assert.deepEqual(
    resolveServedIdentity("openrouter", { model: "openai/gpt-6-luna" }, undefined, {
      model: "openai/gpt-6-luna-2026-10-06",
    }),
    {
      provider: "openrouter",
      model: "openai/gpt-6-luna-2026-10-06",
      modelSource: "provider_response",
      providerInstanceId: null,
    }
  );
  assert.equal(resolveServedIdentity("openai", null), null);
  assert.equal(resolveServedIdentity("openai", { model: " " }), null);
});

test("served identity resolves the concrete model returned by the OpenRouter free router", () => {
  assert.deepEqual(
    resolveServedIdentity("openrouter", { model: "openrouter/free" }, undefined, {
      model: "meta-llama/llama-3.3-70b-instruct:free",
    }),
    {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      modelSource: "provider_response",
      providerInstanceId: null,
    }
  );
});

test("served provider maps an exact internal node to its configured public prefix", () => {
  const lookup = (id: string) =>
    id === "codex-node-id"
      ? { id, prefix: "codex-bridge" }
      : id === "codex2-node-id"
        ? { id, prefix: "codex2-bridge" }
        : null;

  assert.deepEqual(resolveServedIdentity("codex-node-id", { model: "codex" }, lookup), {
    provider: "codex-bridge",
    model: "codex",
    modelSource: "outbound_request",
    providerInstanceId: "codex-node-id",
  });
  assert.deepEqual(resolveServedIdentity("codex2-node-id", { model: "codex2" }, lookup), {
    provider: "codex2-bridge",
    model: "codex2",
    modelSource: "outbound_request",
    providerInstanceId: "codex2-node-id",
  });
  assert.deepEqual(resolveServedIdentity("unknown-node-id", { model: "codex" }, lookup), {
    provider: "unknown-node-id",
    model: "codex",
    modelSource: "outbound_request",
    providerInstanceId: null,
  });
});

test("OpenRouter provider-reported cost is retained only for OpenRouter usage", () => {
  const responseUsage = extractUsageFromResponse(
    { usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.0042 } },
    "openrouter"
  );
  assert.equal(responseUsage.provider_reported_cost_usd, 0.0042);
  assert.equal(
    extractUsageFromResponse({ usage: { prompt_tokens: 7, cost: 0.0042 } }, "openai")
      .provider_reported_cost_usd,
    undefined
  );

  const normalized = normalizeUsage(responseUsage);
  assert.equal(normalized.provider_reported_cost_usd, 0.0042);
  assert.equal(
    computeCostFromPricing(
      { input: 2, output: 4 },
      { input: 7, output: 3, provider_reported_cost_usd: 0.0042 },
      { provider: "openrouter" }
    ),
    0.0042
  );
  const streamed = extractUsage(
    { usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.0042 } },
    "openrouter"
  );
  assert.equal(streamed.provider_reported_cost_usd, 0.0042);
  assert.equal(
    extractUsage({ usage: { prompt_tokens: 7, cost: 0.0042 } }, "openai")
      .provider_reported_cost_usd,
    undefined
  );
});

test("accounting distinguishes provider-reported, estimated, usage-only and unknown", () => {
  assert.deepEqual(
    classifyCostAccounting({
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      usage: { prompt_tokens: 7, provider_reported_cost_usd: 0.0042 },
      calculatedCostUsd: 0.0042,
    }),
    {
      kind: "provider_reported_billed_cost",
      amountUsd: 0.0042,
      currency: "USD",
      source: "openrouter_response.usage.cost",
      pricingProvider: "openrouter",
      pricingModel: "openai/gpt-4o-mini",
      pricingVersion: null,
      pricingEffectiveAt: null,
      pricingRetrievedAt: null,
      pricingStale: null,
      pricingCondition: null,
      usageKind: "provider_reported_usage",
    }
  );
  assert.equal(
    classifyCostAccounting({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      calculatedCostUsd: 0.002,
    }).kind,
    "estimated_cost"
  );
  assert.deepEqual(
    classifyCostAccounting({
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      calculatedCostUsd: 0.001,
      pricingEvidence: {
        source: "modelsDev",
        modelId: "meta-llama/llama-3.3-70b-instruct:free",
        retrievedAt: "2026-10-12T12:00:00.000Z",
        ttlMs: 60_000,
        stale: false,
      },
    }),
    {
      kind: "estimated_cost",
      amountUsd: 0.001,
      currency: "USD",
      source: "models_dev.api_json",
      pricingProvider: "openrouter",
      pricingModel: "meta-llama/llama-3.3-70b-instruct:free",
      pricingVersion: null,
      pricingEffectiveAt: null,
      pricingRetrievedAt: "2026-10-12T12:00:00.000Z",
      pricingStale: false,
      pricingCondition: null,
      usageKind: "provider_reported_usage",
    }
  );
  assert.equal(
    classifyCostAccounting({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 7 },
      calculatedCostUsd: 0,
      calculatedCostKnown: true,
    }).kind,
    "estimated_cost"
  );
  assert.equal(
    classifyCostAccounting({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 7 },
      calculatedCostUsd: 0,
    }).kind,
    "usage_only"
  );
  assert.equal(
    classifyCostAccounting({
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 7, estimated: true },
      calculatedCostUsd: 0,
    }).usageKind,
    "estimated_usage"
  );
  assert.equal(
    classifyCostAccounting({ provider: null, model: null, usage: null, calculatedCostUsd: 0 }).kind,
    "unknown"
  );
});

test("an exact provider-reported charge does not imply provider-reported token usage", () => {
  const openRouterCostOnly = classifyCostAccounting({
    provider: "openrouter",
    model: "vendor/model",
    usage: { provider_reported_cost_usd: 0.0042 },
    calculatedCostUsd: 0.0042,
  });
  assert.equal(openRouterCostOnly.kind, "provider_reported_billed_cost");
  assert.equal(openRouterCostOnly.usageKind, "unknown");

  const xaiCostOnly = classifyCostAccounting({
    provider: "xai",
    model: "grok-model",
    usage: { cost_in_usd_ticks: 42_000_000 },
    calculatedCostUsd: 0.0042,
  });
  assert.equal(xaiCostOnly.kind, "provider_reported_billed_cost");
  assert.equal(xaiCostOnly.usageKind, "unknown");
  assert.equal(xaiCostOnly.amountUsdExact, "0.0042");
});

test("modal cost accounting distinguishes unknown pricing from a zero-value estimate", () => {
  const pricingEvidence = {
    source: "modelsDev" as const,
    modelId: "image-model",
    retrievedAt: 1_797_000_000_000,
    ttlMs: 60_000,
    stale: false,
  };
  assert.deepEqual(
    classifyModalCostAccounting({
      provider: "image-provider",
      model: "image-model",
      costUsd: null,
      pricingEvidence,
    }),
    {
      kind: "unknown",
      amountUsd: null,
      currency: null,
      source: "models_dev.api_json",
      pricingProvider: "image-provider",
      pricingModel: "image-model",
      pricingVersion: null,
      pricingEffectiveAt: null,
      pricingRetrievedAt: new Date(pricingEvidence.retrievedAt).toISOString(),
      pricingStale: false,
      pricingCondition: null,
      usageKind: "estimated_usage",
    }
  );
  assert.equal(
    classifyModalCostAccounting({
      provider: "image-provider",
      model: "image-model",
      costUsd: 0,
      pricingEvidence,
    }).kind,
    "estimated_cost"
  );
  assert.equal(
    classifyModalCostAccounting({
      provider: "image-provider",
      model: "image-model",
      costUsd: 0,
      pricingEvidence,
    }).amountUsd,
    0
  );
});

test("partial rates do not become a zero-priced used billing dimension", () => {
  const usage = { prompt_tokens: 1_000_000, completion_tokens: 50 };
  const estimate = computeCostFromPricing({ input: 2 }, usage);

  assert.equal(estimate, 0);
  assert.equal(
    classifyCostAccounting({
      provider: "vendor",
      model: "partial-price-model",
      usage,
      calculatedCostUsd: estimate,
    }).kind,
    "usage_only"
  );
});

test("partial rates may estimate when every used token dimension has a known price", () => {
  assert.equal(computeCostFromPricing({ input: 2 }, { input: 1_000_000, output: 0 }), 2);
});
