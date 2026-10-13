import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOpenRouterGenerationReceipts,
  type CostAccountingFacts,
} from "../../src/lib/usage/costAccounting.ts";
import {
  fetchOpenRouterGenerationReceipt,
  isOpenRouterGenerationId,
  type OpenRouterGenerationReceipt,
} from "../../src/lib/usage/openrouterGeneration.ts";
import { scheduleOpenRouterReceiptEnrichment } from "../../open-sse/handlers/chatCore/openrouterReceiptEnrichment.ts";

const accounting: CostAccountingFacts = {
  kind: "estimated_cost",
  amountUsd: 0.25,
  currency: "USD",
  source: "models_dev.api_json",
  pricingProvider: "openrouter",
  pricingModel: "vendor/model",
  pricingVersion: null,
  pricingEffectiveAt: null,
  pricingRetrievedAt: null,
  pricingStale: null,
  usageKind: "provider_reported_usage",
};

function receipt(id: string, totalCostUsd: number | null, providerName = "Host A") {
  return {
    id,
    source: "openrouter.generation_api",
    retrievedAt: "2026-10-13T00:00:00.000Z",
    model: "vendor/model",
    providerName,
    upstreamId: `upstream-${id}`,
    promptTokens: 12,
    completionTokens: 7,
    totalCostUsd,
    upstreamInferenceCostUsd: totalCostUsd,
    isByok: false,
  } satisfies OpenRouterGenerationReceipt;
}

test("generation receipt lookup validates generation identity and keeps reported facts", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  const result = await fetchOpenRouterGenerationReceipt(
    "gen-123",
    "sk-safe-test",
    async (input, init) => {
      capturedUrl = String(input);
      capturedAuthorization = new Headers(init?.headers).get("authorization") || "";
      return Response.json({
        data: {
          id: "gen-123",
          model: "vendor/model",
          provider_name: "Host A",
          upstream_id: "upstream-1",
          tokens_prompt: 12,
          tokens_completion: 7,
          total_cost: 0.00025,
          upstream_inference_cost: 0.0002,
          is_byok: false,
        },
      });
    }
  );

  assert.ok(result);
  assert.equal(new URL(capturedUrl).origin, "https://openrouter.ai");
  assert.equal(new URL(capturedUrl).searchParams.get("id"), "gen-123");
  assert.equal(capturedAuthorization, "Bearer sk-safe-test");
  assert.equal(result.providerName, "Host A");
  assert.equal(result.totalCostUsd, 0.00025);
  assert.equal(result.upstreamInferenceCostUsd, 0.0002);

  const mismatch = await fetchOpenRouterGenerationReceipt("gen-123", "sk-safe-test", async () =>
    Response.json({ data: { id: "another-generation" } })
  );
  assert.equal(mismatch, null);
});

test("generation receipt lookup treats unavailable metadata as unknown", async () => {
  const unavailable = await fetchOpenRouterGenerationReceipt(
    "gen-404",
    "sk-safe-test",
    async () => new Response(null, { status: 404 }),
    async () => {}
  );
  assert.equal(unavailable, null);

  const malformed = await fetchOpenRouterGenerationReceipt("gen-bad", "sk-safe-test", async () =>
    Response.json({ data: { id: "gen-bad", total_cost: "free" } })
  );
  assert.equal(malformed?.totalCostUsd, null);
  assert.equal(malformed?.providerName, null);
});

test("generation receipt lookup retries one briefly unindexed generation", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await fetchOpenRouterGenerationReceipt(
    "gen-delayed",
    "sk-safe-test",
    async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 404 })
        : Response.json({ data: { id: "gen-delayed", total_cost: 0.0001, is_byok: false } });
    },
    async (delayMs) => {
      delays.push(delayMs);
    }
  );

  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(result?.totalCostUsd, 0.0001);
});

test("only OpenRouter generation ids are eligible for metadata lookup", () => {
  assert.equal(isOpenRouterGenerationId("gen-123-Abc"), true);
  assert.equal(isOpenRouterGenerationId("request-123"), false);
  assert.equal(isOpenRouterGenerationId(`gen-${"x".repeat(126)}`), false);
});

test("accounting aggregates only complete provider-reported generation costs", () => {
  const complete = applyOpenRouterGenerationReceipts(
    accounting,
    ["gen-1", "gen-2"],
    [receipt("gen-1", 0.0002), receipt("gen-2", 0.0003, "Host B")]
  );
  assert.equal(complete.kind, "provider_reported_billed_cost");
  assert.equal(complete.amountUsd, 0.0005);
  assert.equal(complete.source, "openrouter.generation_api.total_cost");
  assert.equal(complete.downstreamProvider, "Host B");
  assert.equal(complete.providerReceipts?.length, 2);
  assert.equal(complete.providerReceiptsComplete, true);
  assert.equal(complete.providerReceiptIncompleteIds, undefined);

  const decimalTotals = applyOpenRouterGenerationReceipts(
    accounting,
    ["tiny-1", "tiny-2"],
    [receipt("tiny-1", 0.00000001), receipt("tiny-2", 0.00000002)]
  );
  assert.equal(decimalTotals.amountUsd, 0.00000003);
  assert.equal(decimalTotals.amountUsdExact, "0.00000003");

  const partial = applyOpenRouterGenerationReceipts(
    accounting,
    ["gen-1", "gen-2"],
    [receipt("gen-1", 0.0002)]
  );
  assert.equal(partial.kind, "estimated_cost");
  assert.equal(partial.amountUsd, 0.25);
  assert.equal(partial.providerReceipts?.length, 1);
  assert.equal(partial.providerReceiptsComplete, false);
  assert.deepEqual(partial.providerReceiptIncompleteIds, ["gen-2"]);

  const byok = applyOpenRouterGenerationReceipts(
    accounting,
    ["gen-byok"],
    [{ ...receipt("gen-byok", 0), isByok: true }]
  );
  assert.equal(byok.kind, "estimated_cost");
  assert.equal(byok.amountUsd, 0.25);
  assert.equal(byok.providerReceiptsComplete, false);
  assert.deepEqual(byok.providerReceiptIncompleteIds, ["gen-byok"]);

  const receiptWithoutCost = applyOpenRouterGenerationReceipts(
    accounting,
    ["gen-no-cost"],
    [{ ...receipt("gen-no-cost", 0), totalCostUsd: null }]
  );
  assert.equal(receiptWithoutCost.providerReceiptsComplete, false);
  assert.deepEqual(receiptWithoutCost.providerReceiptIncompleteIds, ["gen-no-cost"]);
});

test("receipt enrichment waits for call-log persistence and updates existing records", async () => {
  const events: string[] = [];
  let finish!: () => void;
  const callLogSaved = new Promise<void>((resolve) => {
    finish = resolve;
  });
  scheduleOpenRouterReceiptEnrichment(
    {
      generationIds: ["gen-1"],
      apiKey: "sk-safe-test",
      usageRequestId: "usage-id",
      callLogId: "call-id",
      accounting,
    },
    callLogSaved,
    {
      fetchReceipts: async () => [receipt("gen-1", 0.0002)],
      updateUsage: async (id, facts) => {
        events.push(`usage:${id}:${facts.kind}`);
      },
      updateCallLog: (id, facts) => {
        events.push(`call:${id}:${facts.kind}`);
      },
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, [
    "usage:usage-id:provider_reported_billed_cost",
    "call:call-id:provider_reported_billed_cost",
  ]);
});
