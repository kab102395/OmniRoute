import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateQuota,
  buildCandidateView,
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
    excluded: false,
    reachable: true,
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
  const view = candidate({ model: "openrouter/provider/model" });
  assert.equal(view.free, false);
  assert.equal(view.quota, null);
});

test("exhausted free quota is reported as zero remaining, not unknown", () => {
  const view = candidate({
    cache: cache({ remaining: 0, total: 1000, resetAt: "2026-09-09T00:00:00.000Z" }),
  });
  assert.equal(view.quota?.remaining, 0);
  assert.equal(view.quota?.limit, 1000);
});

test("breaker and cooldown state are preserved without affecting routing", () => {
  const view = candidate({
    reachable: false,
    breakerState: "OPEN",
    connectionCooldown: true,
  });
  assert.equal(view.reachable, false);
  assert.equal(view.breakerState, "OPEN");
  assert.equal(view.connectionCooldown, true);
});

test("candidate telemetry does not expose raw connection IDs or secrets", () => {
  const view = candidate();
  assert.equal("connectionId" in view, false);
  assert.equal(JSON.stringify(view).includes("internal-connection-id"), false);
  assert.equal(JSON.stringify(view).match(/sk-[A-Za-z0-9_-]+/), null);
});

test("candidate telemetry preserves the routing reachability decision", () => {
  const reachable = candidate({ reachable: true });
  const blocked = candidate({ reachable: false, modelLocked: true });
  assert.equal(reachable.reachable, true);
  assert.equal(blocked.reachable, false);
  assert.equal(blocked.modelLocked, true);
});
