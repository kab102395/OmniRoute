import assert from "node:assert/strict";
import { test } from "node:test";
import { readSmartRoutingReceipt } from "../../src/lib/a2a/skills/smartRouting.ts";

test("A2A routing receipt preserves actual provider-reported cost and route provenance", () => {
  const response = new Response("{}", {
    headers: {
      "X-OmniRoute-Accounting-Kind": "provider_reported_billed_cost",
      "X-OmniRoute-Response-Cost": "0.0012500000",
      "X-OmniRoute-Cost-Currency": "USD",
      "X-OmniRoute-Cost-Source": "openrouter_response.usage.cost",
      "X-OmniRoute-Request-Id": "request-123",
      "X-OmniRoute-Served-Model": "vendor/model:free",
      "X-OmniRoute-Served-Provider": "openrouter",
      "X-OmniRoute-Fallback-Attempts": "2",
    },
  });

  assert.deepEqual(readSmartRoutingReceipt(response, "vendor/model:free"), {
    estimated: null,
    actual: 0.00125,
    currency: "USD",
    accountingKind: "provider_reported_billed_cost",
    accountingSource: "openrouter_response.usage.cost",
    pricingRetrievedAt: null,
    pricingStale: null,
    requestId: "request-123",
    servedModel: "vendor/model:free",
    servedProvider: "openrouter",
    fallbackAttempts: 2,
    requestedModel: "vendor/model:free",
  });
});

test("A2A routing receipt keeps unknown and usage-only costs unknown", () => {
  for (const accountingKind of ["unknown", "usage_only", "pending", null]) {
    const response = new Response("{}", {
      headers: accountingKind ? { "X-OmniRoute-Accounting-Kind": accountingKind } : {},
    });
    const receipt = readSmartRoutingReceipt(response, "auto");
    assert.equal(receipt.actual, null, accountingKind ?? "missing accounting kind");
    assert.equal(receipt.estimated, null, accountingKind ?? "missing accounting kind");
    assert.equal(receipt.currency, null, accountingKind ?? "missing accounting kind");
  }
});

test("A2A routing receipt separates estimated cost from actual charges", () => {
  const response = new Response("{}", {
    headers: {
      "X-OmniRoute-Accounting-Kind": "estimated_cost",
      "X-OmniRoute-Response-Cost": "0.02",
      "X-OmniRoute-Pricing-Retrieved-At": "2026-10-13T10:00:00.000Z",
      "X-OmniRoute-Pricing-Stale": "false",
    },
  });

  const receipt = readSmartRoutingReceipt(response, "provider/model");
  assert.equal(receipt.estimated, 0.02);
  assert.equal(receipt.actual, null);
  assert.equal(receipt.pricingRetrievedAt, "2026-10-13T10:00:00.000Z");
  assert.equal(receipt.pricingStale, false);
});
