import test from "node:test";
import assert from "node:assert/strict";

import {
  attachOmniRouteMetaHeaders,
  buildOmniRouteResponseMetaHeaders,
  buildOmniRouteSseMetadataComment,
  formatOmniRouteCost,
  getOmniRouteTokenCounts,
} from "../../src/domain/omnirouteResponseMeta.ts";
import { APP_CONFIG } from "../../src/shared/constants/appConfig.ts";
import { OMNIROUTE_RESPONSE_HEADERS } from "../../src/shared/constants/headers.ts";

test("getOmniRouteTokenCounts normalizes common usage shapes", () => {
  assert.deepEqual(
    getOmniRouteTokenCounts({
      prompt_tokens: 12,
      completion_tokens: 5,
    }),
    { input: 12, output: 5 }
  );
  assert.deepEqual(
    getOmniRouteTokenCounts({
      input_tokens: "9",
      output_tokens: "4",
    }),
    { input: 9, output: 4 }
  );
});

test("buildOmniRouteResponseMetaHeaders formats provider alias, tokens, latency, and cost", () => {
  const headers = buildOmniRouteResponseMetaHeaders({
    provider: "claude",
    model: "claude-sonnet-4-6",
    cacheHit: true,
    latencyMs: 1234.6,
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
    },
    costUsd: 0.00123456789,
  });

  assert.equal(headers["X-OmniRoute-Provider"], "cc");
  assert.equal(headers["X-OmniRoute-Model"], "claude-sonnet-4-6");
  assert.equal(headers["X-OmniRoute-Cache-Hit"], "true");
  assert.equal(headers["X-OmniRoute-Latency-Ms"], "1235");
  assert.equal(headers["X-OmniRoute-Tokens-In"], "11");
  assert.equal(headers["X-OmniRoute-Tokens-Out"], "7");
  assert.equal(headers["X-OmniRoute-Response-Cost"], "0.0012345679");
});

test("cost metadata preserves explicit zero and omits missing or malformed amounts", () => {
  assert.equal(formatOmniRouteCost(0), "0.0000000000");
  assert.equal(formatOmniRouteCost("0"), "0.0000000000");
  assert.equal(formatOmniRouteCost(null), null);
  assert.equal(formatOmniRouteCost(""), null);
  assert.equal(formatOmniRouteCost("not-a-price"), null);
  assert.equal(formatOmniRouteCost(-0.1), null);

  const headers = buildOmniRouteResponseMetaHeaders({
    costUsd: "not-a-price",
    costSavedUsd: "",
  });
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.responseCost], undefined);
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.costSaved], undefined);
});

test("unknown accounting omits legacy zero cost while verified zero remains explicit", () => {
  const unknown = buildOmniRouteResponseMetaHeaders({
    costUsd: 0,
    accounting: { kind: "unknown", currency: null, usageKind: "unknown" },
  });
  assert.equal(unknown[OMNIROUTE_RESPONSE_HEADERS.responseCost], undefined);
  assert.equal(unknown[OMNIROUTE_RESPONSE_HEADERS.accountingKind], "unknown");

  const verifiedZero = buildOmniRouteResponseMetaHeaders({
    costUsd: 0,
    accounting: { kind: "zero_cost", currency: "USD", usageKind: "provider_reported_usage" },
  });
  assert.equal(verifiedZero[OMNIROUTE_RESPONSE_HEADERS.responseCost], "0.0000000000");
  assert.equal(verifiedZero[OMNIROUTE_RESPONSE_HEADERS.accountingKind], "zero_cost");

  for (const kind of ["usage_only", "pending"]) {
    const unpriced = buildOmniRouteResponseMetaHeaders({
      costUsd: 0,
      accounting: { kind, currency: null, usageKind: "unknown" },
    });
    assert.equal(unpriced[OMNIROUTE_RESPONSE_HEADERS.responseCost], undefined);
  }
});

test("response metadata does not invent a zero amount when the caller has no cost fact", () => {
  const headers = buildOmniRouteResponseMetaHeaders({ fallbackAttempts: 1 });
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.responseCost], undefined);
});

test("response metadata exposes additional upstream attempts", () => {
  const headers = buildOmniRouteResponseMetaHeaders({ fallbackAttempts: 2 });
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.fallbackAttempts], "2");
});

test("response metadata exposes the final provider request id when available", () => {
  const headers = buildOmniRouteResponseMetaHeaders({ providerRequestId: "gen-123" });
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.providerRequestId], "gen-123");
  assert.equal(
    buildOmniRouteResponseMetaHeaders({})[OMNIROUTE_RESPONSE_HEADERS.providerRequestId],
    undefined
  );
});

test("buildOmniRouteResponseMetaHeaders keeps ASCII model header values unchanged", () => {
  const headers = buildOmniRouteResponseMetaHeaders({
    provider: "openai",
    model: "gpt-4o-mini",
  });

  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], "gpt-4o-mini");
});

test("buildOmniRouteResponseMetaHeaders separates public served provider from internal IDs", () => {
  const headers = buildOmniRouteResponseMetaHeaders({
    servedProvider: "codex2-bridge",
    servedModel: "codex2",
    servedModelSource: "provider_response",
    servedProviderInstanceId: "codex2-node-id",
    connectionId: "connection-2",
  });

  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.servedProvider], "codex2-bridge");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.servedModel], "codex2");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.servedModelSource], "provider_response");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.servedProviderInstanceId], "codex2-node-id");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.connectionId], "connection-2");
});

test("buildOmniRouteResponseMetaHeaders percent-encodes non-ASCII model header values", () => {
  const model = "free-mix/[假流式]gemini-3.7-flash";
  const headers = buildOmniRouteResponseMetaHeaders({
    provider: "openai",
    model,
  });

  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], encodeURIComponent(model));
  assert.doesNotThrow(() => new Headers(headers));
});

test("buildOmniRouteResponseMetaHeaders strips control characters from string header values", () => {
  const headers = buildOmniRouteResponseMetaHeaders({
    provider: "openai",
    model: "free\r\nX-Injected: yes\u0000-model",
    requestId: "req-1\nreq-2\rreq-3\u0007",
  });

  assert.doesNotMatch(headers[OMNIROUTE_RESPONSE_HEADERS.model], /[\r\n\u0000-\u001f\u007f]/);
  assert.doesNotMatch(headers[OMNIROUTE_RESPONSE_HEADERS.requestId], /[\r\n\u0000-\u001f\u007f]/);
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], "freeX-Injected: yes-model");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.requestId], "req-1req-2req-3");
  assert.doesNotThrow(() => new Headers(headers));
});

test("buildOmniRouteResponseMetaHeaders always emits X-OmniRoute-Version", () => {
  const headers = buildOmniRouteResponseMetaHeaders({ provider: "openai", model: "gpt" });
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.version], APP_CONFIG.version);

  // Even with no provider/model at all, the version is still attached.
  const bare = buildOmniRouteResponseMetaHeaders({});
  assert.equal(bare[OMNIROUTE_RESPONSE_HEADERS.version], APP_CONFIG.version);
});

test("buildOmniRouteResponseMetaHeaders exposes cost pricing provenance and freshness", () => {
  const headers = buildOmniRouteResponseMetaHeaders({
    accounting: {
      kind: "estimated_cost",
      source: "models_dev.api_json",
      currency: "USD",
      usageKind: "estimated_usage",
      pricingRetrievedAt: "2026-10-12T00:00:00.000Z",
      pricingStale: false,
    },
  });

  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.accountingKind], "estimated_cost");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.costSource], "models_dev.api_json");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.pricingRetrievedAt], "2026-10-12T00:00:00.000Z");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.pricingStale], "false");
});

test("buildOmniRouteResponseMetaHeaders emits X-OmniRoute-Request-Id only when provided", () => {
  const withId = buildOmniRouteResponseMetaHeaders({ model: "gpt", requestId: "req-123" });
  assert.equal(withId[OMNIROUTE_RESPONSE_HEADERS.requestId], "req-123");

  const noId = buildOmniRouteResponseMetaHeaders({ model: "gpt" });
  assert.equal(noId[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);

  const nullId = buildOmniRouteResponseMetaHeaders({ model: "gpt", requestId: null });
  assert.equal(nullId[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);

  const blankId = buildOmniRouteResponseMetaHeaders({ model: "gpt", requestId: "   " });
  assert.equal(blankId[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);
});

test("attachOmniRouteMetaHeaders mutates a Headers instance in place, preserving existing entries", () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  attachOmniRouteMetaHeaders(headers, {
    provider: "openai",
    model: "gpt",
    requestId: "req-abc",
  });

  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.version), APP_CONFIG.version);
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.requestId), "req-abc");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.model), "gpt");
});

test("attachOmniRouteMetaHeaders mutates a plain record in place, preserving existing entries", () => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  attachOmniRouteMetaHeaders(headers, {
    provider: "openai",
    model: "gpt",
  });

  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.version], APP_CONFIG.version);
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.model], "gpt");
  // No requestId provided → header omitted.
  assert.equal(headers[OMNIROUTE_RESPONSE_HEADERS.requestId], undefined);
});

test("buildOmniRouteSseMetadataComment emits comment lines compatible with SSE", () => {
  const comment = buildOmniRouteSseMetadataComment({
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      prompt_tokens: 4,
      completion_tokens: 2,
    },
    latencyMs: 50,
    costUsd: formatOmniRouteCost(0),
  });

  assert.match(comment, /^: x-omniroute-cache-hit=false/m);
  assert.match(comment, /^: x-omniroute-provider=openai/m);
  assert.match(comment, /^: x-omniroute-model=gpt-4o-mini/m);
  assert.match(comment, /^: x-omniroute-tokens-in=4/m);
  assert.match(comment, /^: x-omniroute-tokens-out=2/m);
  assert.match(comment, /^: x-omniroute-response-cost=0\.0000000000/m);
});

test("buildOmniRouteResponseMetaHeaders emits X-OmniRoute-Cost-Saved only when costSavedUsd is provided", () => {
  // Cache HIT: the incremental cost of serving the hit is 0, but the cache saved the
  // original (would-have-been) cost — surfaced via the Cost-Saved header for analytics.
  const hit = buildOmniRouteResponseMetaHeaders({
    provider: "openai",
    model: "gpt-4o",
    cacheHit: true,
    costUsd: 0,
    costSavedUsd: 0.0125,
  });
  assert.equal(hit[OMNIROUTE_RESPONSE_HEADERS.responseCost], "0.0000000000");
  assert.equal(hit[OMNIROUTE_RESPONSE_HEADERS.costSaved], "0.0125000000");

  // A normal response (no costSavedUsd) omits the Cost-Saved header entirely.
  const miss = buildOmniRouteResponseMetaHeaders({
    provider: "openai",
    model: "gpt-4o",
    costUsd: 0.0125,
  });
  assert.equal(miss[OMNIROUTE_RESPONSE_HEADERS.costSaved], undefined);

  // A free-model HIT still emits Cost-Saved (= 0) — it explicitly passed costSavedUsd.
  const freeHit = buildOmniRouteResponseMetaHeaders({
    cacheHit: true,
    costUsd: 0,
    costSavedUsd: 0,
  });
  assert.equal(freeHit[OMNIROUTE_RESPONSE_HEADERS.costSaved], "0.0000000000");
});

test("attachOmniRouteMetaHeaders forwards costSavedUsd onto a Headers bag", () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  attachOmniRouteMetaHeaders(headers, {
    provider: "openai",
    model: "gpt-4o",
    cacheHit: true,
    costUsd: 0,
    costSavedUsd: 0.0125,
  });
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.responseCost), "0.0000000000");
  assert.equal(headers.get(OMNIROUTE_RESPONSE_HEADERS.costSaved), "0.0125000000");
});
