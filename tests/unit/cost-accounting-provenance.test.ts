import test from "node:test";
import assert from "node:assert/strict";
import { classifyCostAccounting } from "../../src/lib/usage/costAccounting.ts";
import { resolveServedIdentity } from "../../open-sse/handlers/chatCore/servedIdentity.ts";
import { extractUsageFromResponse } from "../../open-sse/handlers/usageExtractor.ts";
import { extractUsage, normalizeUsage } from "../../open-sse/utils/usageTracking.ts";
import { computeCostFromPricing } from "../../src/lib/usage/costCalculator.ts";

test("served identity follows the final successful outbound model after fallback or retry", () => {
  assert.deepEqual(resolveServedIdentity("openai", { model: "provider-b/model-2" }), {
    provider: "openai",
    model: "provider-b/model-2",
  });
  assert.deepEqual(resolveServedIdentity("anthropic", { model: "claude-sonnet-4-6" }), {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
  assert.equal(resolveServedIdentity("openai", null), null);
  assert.equal(resolveServedIdentity("openai", { model: " " }), null);
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
