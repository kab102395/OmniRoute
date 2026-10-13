import assert from "node:assert/strict";
import test from "node:test";
import {
  getExecutionRetryCount,
  isExecutionRouteFallback,
} from "../../open-sse/handlers/chatCore/executionAttemptTelemetry.ts";

test("execution retry count is based on attempts after the initial dispatch", () => {
  assert.equal(getExecutionRetryCount(0), 0);
  assert.equal(getExecutionRetryCount(1), 0);
  assert.equal(getExecutionRetryCount(3), 2);
  assert.equal(getExecutionRetryCount(Number.NaN), 0);
});

test("same-route executor retries do not claim a fallback", () => {
  assert.equal(
    isExecutionRouteFallback(
      { connectionId: "account-a", routeModel: "model-a" },
      { connectionId: "account-a", routeModel: "model-a" }
    ),
    false
  );
});

test("account changes, model changes, and proxy fallback legs are reported", () => {
  const initial = { connectionId: "account-a", routeModel: "model-a" };
  assert.equal(
    isExecutionRouteFallback(initial, { connectionId: "account-b", routeModel: "model-a" }),
    true
  );
  assert.equal(
    isExecutionRouteFallback(initial, { connectionId: "account-a", routeModel: "model-b" }),
    true
  );
  assert.equal(
    isExecutionRouteFallback(initial, {
      connectionId: "account-a",
      routeModel: "model-a",
      routeLeg: "proxy_fallback",
    }),
    true
  );
});
