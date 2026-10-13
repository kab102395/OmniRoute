import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRouteSimulation,
  getComboModels,
} from "../../open-sse/mcp-server/tools/advancedTools.ts";
import { simulateRouteOutput } from "../../open-sse/mcp-server/schemas/tools.ts";

test("route simulation preserves unknown probabilities, prices, health, and quota", () => {
  const models = getComboModels({
    models: [{ provider: "openai", model: "gpt-unknown-price" }],
  });
  assert.equal(models[0]?.inputCostPer1M, null, "missing combo pricing must not default to $3/M");
  const result = buildRouteSimulation(models, 1000, [], []);

  assert.deepEqual(result.simulatedPath[0], {
    provider: "openai",
    model: "openai/gpt-unknown-price",
    probability: null,
    probabilitySource: "unavailable",
    estimatedCost: null,
    costEstimate: {
      state: "unknown",
      source: "unavailable",
      currency: "USD",
      scope: "input_tokens_only",
    },
    healthStatus: "unknown",
    healthSource: "unknown",
    quotaAvailable: null,
    quotaSource: "unknown",
    quotaRetrievedAt: null,
  });
  assert.equal(result.fallbackTree.bestCaseCost, null);
  assert.equal(result.fallbackTree.worstCaseCost, null);
  assert.equal(result.fallbackTree.costEstimateState, "unknown");
  assert.equal(simulateRouteOutput.safeParse(result).success, true);
});

test("route simulation uses observed health, quota, and configured input rates only", () => {
  const result = buildRouteSimulation(
    [{ provider: "openai", model: "gpt-configured", inputCostPer1M: 2.5 }],
    1000,
    [{ provider: "openai", state: "DEGRADED" }],
    [
      {
        provider: "openai",
        percentRemaining: 23,
        quotaSource: "learned_limit",
        quotaRetrievedAt: "2026-10-13T00:00:00.000Z",
      },
    ]
  );

  assert.equal(result.simulatedPath[0]?.estimatedCost, 0.0025);
  assert.deepEqual(result.simulatedPath[0]?.costEstimate, {
    state: "input_estimate",
    source: "combo_config",
    currency: "USD",
    scope: "input_tokens_only",
  });
  assert.equal(result.simulatedPath[0]?.probability, null);
  assert.equal(result.simulatedPath[0]?.healthStatus, "DEGRADED");
  assert.equal(result.simulatedPath[0]?.healthSource, "provider_breaker");
  assert.equal(result.simulatedPath[0]?.quotaAvailable, 23);
  assert.equal(result.simulatedPath[0]?.quotaSource, "learned_limit");
  assert.equal(result.simulatedPath[0]?.quotaRetrievedAt, "2026-10-13T00:00:00.000Z");
  assert.equal(result.fallbackTree.bestCaseCost, 0.0025);
  assert.equal(result.fallbackTree.worstCaseCost, 0.0025);
  assert.equal(simulateRouteOutput.safeParse(result).success, true);
});

test("queue pressure is not presented as provider quota", () => {
  const result = buildRouteSimulation(
    [{ provider: "openai", model: "gpt-configured", inputCostPer1M: 2.5 }],
    1000,
    [],
    [
      {
        provider: "openai",
        percentRemaining: 75,
        quotaSource: "observed_queue_pressure",
        quotaRetrievedAt: "2026-10-13T00:00:00.000Z",
      },
    ]
  );

  assert.equal(result.simulatedPath[0]?.quotaAvailable, null);
  assert.equal(result.simulatedPath[0]?.quotaSource, "observed_queue_pressure");
  assert.equal(simulateRouteOutput.safeParse(result).success, true);
});
