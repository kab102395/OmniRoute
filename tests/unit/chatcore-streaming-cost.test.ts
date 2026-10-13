// Characterization of recordStreamingCost — the streaming per-request cost recording extracted
// from handleChatCore's onStreamComplete (chatCore god-file decomposition, #3501). Sync
// fire-and-forget; pricing evidence, classification, and recording are injected, so behavior is
// observable without a DB. Unknown/usage-only estimates must be recorded as uncertainty.
import { test } from "node:test";
import assert from "node:assert/strict";

const { recordStreamingCost } = await import("../../open-sse/handlers/chatCore/streamingCost.ts");

function spies(costValue: number, costKnown = true) {
  const recorded: Array<{ apiKeyId: string; cost: number }> = [];
  const unknown: string[] = [];
  const costArgs: Array<{ provider: string; model: string; requestCount?: number }> = [];
  return {
    recorded,
    costArgs,
    calculateCostWithEvidence: async (
      provider: string,
      model: string,
      _usage: unknown,
      options?: { requestCount?: number }
    ) => {
      costArgs.push({ provider, model, requestCount: options?.requestCount });
      return {
        costUsd: costValue,
        costKnown,
        pricingEvidence: {
          source: null,
          modelId: null,
          retrievedAt: null,
          ttlMs: null,
          stale: null,
          condition: null,
        },
      };
    },
    recordCostAssessment: (apiKeyId: string, cost: number, known: boolean) => {
      if (!known) unknown.push(apiKeyId);
      else if (cost > 0) recorded.push({ apiKeyId, cost });
    },
    unknown,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !pred()) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("missing apiKeyId → no-op (calculateCost never called)", async () => {
  const s = spies(0.5);
  recordStreamingCost({
    apiKeyId: null,
    provider: "openai",
    model: "gpt-x",
    streamUsage: { prompt_tokens: 10 },
    serviceTier: "standard",
    calculateCostWithEvidence: s.calculateCostWithEvidence,
    recordCostAssessment: s.recordCostAssessment,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.costArgs.length, 0);
  assert.equal(s.recorded.length, 0);
});

test("missing streamUsage records unknown cost for finite budget enforcement", async () => {
  const s = spies(0.5);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: null,
    calculateCostWithEvidence: s.calculateCostWithEvidence,
    recordCostAssessment: s.recordCostAssessment,
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.costArgs.length, 0);
  assert.equal(s.recorded.length, 0);
  assert.deepEqual(s.unknown, ["key-1"]);
});

test("valid input records the resolved cost against the api key", async () => {
  const s = spies(0.0073);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "deepseek",
    model: "deepseek-chat",
    streamUsage: { prompt_tokens: 100, completion_tokens: 50 },
    serviceTier: "standard",
    requestCount: 3,
    calculateCostWithEvidence: s.calculateCostWithEvidence,
    recordCostAssessment: s.recordCostAssessment,
  });
  await waitFor(() => s.recorded.length > 0);
  assert.equal(s.costArgs[0].provider, "deepseek");
  assert.equal(s.costArgs[0].requestCount, 3);
  assert.equal(s.recorded.length, 1);
  assert.equal(s.recorded[0].apiKeyId, "key-1");
  assert.equal(s.recorded[0].cost, 0.0073);
});

test("nonzero stale estimate records uncertainty instead of known spend", async () => {
  const s = spies(0.25, false);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: { prompt_tokens: 1 },
    calculateCostWithEvidence: s.calculateCostWithEvidence,
    recordCostAssessment: s.recordCostAssessment,
  });
  await waitFor(() => s.costArgs.length > 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.costArgs.length, 1);
  assert.equal(s.recorded.length, 0);
  assert.deepEqual(s.unknown, ["key-1"]);
});

test("pricing resolution failure records unknown cost", async () => {
  const s = spies(0);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openai",
    model: "gpt-x",
    streamUsage: { prompt_tokens: 1 },
    calculateCostWithEvidence: async () => {
      throw new Error("pricing unavailable");
    },
    recordCostAssessment: s.recordCostAssessment,
  });

  await waitFor(() => s.unknown.length > 0);
  assert.deepEqual(s.unknown, ["key-1"]);
  assert.equal(s.recorded.length, 0);
});

test("provider-reported verified zero does not create an unknown-cost budget record", async () => {
  const s = spies(0, true);
  recordStreamingCost({
    apiKeyId: "key-1",
    provider: "openrouter",
    model: "vendor/model:free",
    streamUsage: { prompt_tokens: 1, provider_reported_cost_usd: 0 },
    calculateCostWithEvidence: s.calculateCostWithEvidence,
    recordCostAssessment: s.recordCostAssessment,
  });
  await waitFor(() => s.costArgs.length > 0);
  assert.equal(s.unknown.length, 0);
});
