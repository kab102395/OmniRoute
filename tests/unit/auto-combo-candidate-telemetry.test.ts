import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateQuota,
  buildCandidateQuotaWindows,
  buildCandidateView,
  getCandidateReachabilityStatus,
} from "../../open-sse/handlers/autoComboCandidates.ts";

const cache = (quota: Record<string, unknown>) => ({
  quotas: { free_daily: quota },
  plan: null,
  message: null,
  fetchedAt: "2026-09-08T05:00:00.000Z",
});

const candidate = (overrides: Record<string, unknown> = {}) =>
  buildCandidateView({
    provider: "openrouter",
    connectionId: "internal-connection-id",
    model: "openrouter/provider/model:free",
    modelStr: "openrouter/provider/model:free",
    isFree: true,
    excluded: false,
    reachabilityStatus: "reachable",
    breakerState: "CLOSED",
    connectionCooldown: false,
    modelLocked: false,
    freeAccessExclusion: null,
    cache: cache({ remaining: 998, total: 1000, resetAt: "2026-09-09T00:00:00.000Z" }),
    ...overrides,
  });

test("free candidate with known quota is enriched", () => {
  const view = candidate();
  assert.equal(view.free, true);
  assert.deepEqual(view.quota, {
    remaining: 998,
    limit: 1000,
    window: "daily",
    observedAt: "2026-09-08T05:00:00.000Z",
  });
});

test("free candidate with unknown quota remains explicitly unknown", () => {
  assert.equal(buildCandidateQuota(true, null), null);
  assert.equal(candidate({ cache: null }).quota, null);
});

test("paid candidate is not classified as free and has no free quota", () => {
  const view = candidate({
    model: "openrouter/provider/model",
    modelStr: "openrouter/provider/model",
    isFree: false,
  });
  assert.equal(view.free, false);
  assert.equal(view.quota, null);
});

test("catalog classification handles the OpenCode public prefix", () => {
  const view = candidate({
    provider: "opencode",
    model: "oc/deepseek-v4-flash-free",
    modelStr: "oc/deepseek-v4-flash-free",
    isFree: true,
  });
  assert.equal(view.free, true);
});

test("exhausted free quota is reported as zero remaining, not unknown", () => {
  const view = candidate({
    cache: cache({ remaining: 0, total: 1000, resetAt: "2026-09-09T00:00:00.000Z" }),
  });
  assert.equal(view.quota?.remaining, 0);
  assert.equal(view.quota?.limit, 1000);
});

test("candidate diagnostics preserve each cached free quota window", () => {
  const quotaCache = {
    ...cache({ remaining: 7, total: 50, resetAt: "2026-09-09T00:00:00.000Z" }),
    quotas: {
      free_daily: {
        remaining: 7,
        total: 50,
        resetAt: "2026-09-09T00:00:00.000Z",
        displayName: "Free-tier requests (daily)",
      },
      free_rpm: {
        remaining: 18,
        total: 20,
        resetAt: null,
        displayName: "Free-tier requests (per minute)",
      },
      credits: { remaining: 5, total: 10 },
    },
  };
  const withRpm = buildCandidateQuotaWindows(true, quotaCache);
  assert.deepEqual(
    withRpm.map(({ key, remaining, limit, resetAt, source }) => ({
      key,
      remaining,
      limit,
      resetAt,
      source,
    })),
    [
      {
        key: "free_daily",
        remaining: 7,
        limit: 50,
        resetAt: "2026-09-09T00:00:00.000Z",
        source: null,
      },
      { key: "free_rpm", remaining: 18, limit: 20, resetAt: null, source: null },
    ]
  );
  assert.deepEqual(
    candidate({ cache: quotaCache }).quotaWindows.map(({ key }) => key),
    ["free_daily", "free_rpm"],
    "the account candidate response must include all free quota windows"
  );
});

test("breaker and cooldown state are preserved without affecting routing", () => {
  const view = candidate({
    reachabilityStatus: "unreachable",
    breakerState: "OPEN",
    connectionCooldown: true,
  });
  assert.equal(view.reachable, false);
  assert.equal(view.breakerState, "OPEN");
  assert.equal(view.connectionCooldown, true);
});

test("candidate account diagnostics retain connection identity without exposing credentials", () => {
  const view = candidate();
  assert.equal(view.connectionId, "internal-connection-id");
  assert.equal(JSON.stringify(view).match(/sk-[A-Za-z0-9_-]+/), null);
});

test("candidate telemetry preserves the routing reachability decision", () => {
  const reachable = candidate({ reachabilityStatus: "reachable" });
  const blocked = candidate({ reachabilityStatus: "unreachable", modelLocked: true });
  assert.equal(reachable.reachable, true);
  assert.equal(reachable.reachabilityStatus, "reachable");
  assert.equal(blocked.reachable, false);
  assert.equal(blocked.reachabilityStatus, "unreachable");
  assert.equal(blocked.modelLocked, true);
});

test("unknown account lookup is not reported as reachable", () => {
  assert.equal(
    getCandidateReachabilityStatus({
      connectionLookupKnown: false,
      breakerReachable: true,
      connectionCooldown: false,
      modelLocked: false,
    }),
    "unknown"
  );
  assert.equal(
    getCandidateReachabilityStatus({
      connectionLookupKnown: false,
      breakerReachable: false,
      connectionCooldown: false,
      modelLocked: false,
    }),
    "unreachable",
    "a known-open provider breaker takes precedence over unknown account state"
  );
  const view = candidate({ reachabilityStatus: "unknown" });
  assert.equal(view.reachable, false);
  assert.equal(view.reachabilityStatus, "unknown");
});
