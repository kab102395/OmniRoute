import test from "node:test";
import assert from "node:assert/strict";

import {
  createBodyTimeoutError,
  createUpstreamStartTimeoutError,
  createAbortError,
  computeBillableTokens,
  getExecutorTimeoutMs,
  normalizeExecutorResult,
} from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";

test("error factories set name and message", () => {
  const body = createBodyTimeoutError(1234);
  assert.equal(body.name, "BodyTimeoutError");
  assert.match(body.message, /1234ms/);

  const start = createUpstreamStartTimeoutError(500, "openai", "gpt-4o");
  assert.equal(start.name, "TimeoutError");
  assert.match(start.message, /openai\/gpt-4o/);

  const ctrl = new AbortController();
  ctrl.abort("nope");
  const ab = createAbortError(ctrl.signal);
  assert.equal(ab.name, "AbortError");
});

test("computeBillableTokens sums input+output+reasoning (no cache double-count)", () => {
  const total = computeBillableTokens({
    prompt_tokens: 10,
    completion_tokens: 5,
    reasoning_tokens: 2,
  });
  assert.equal(total, 17);
});

test("getExecutorTimeoutMs floors valid values and falls back to default", () => {
  assert.equal(getExecutorTimeoutMs({ getTimeoutMs: () => 1234.9 }), 1234);
  assert.equal(getExecutorTimeoutMs({ getTimeoutMs: () => NaN }), getExecutorTimeoutMs(null));
  assert.ok(Number.isFinite(getExecutorTimeoutMs(null)));
});

test("normalizeExecutorResult wraps bare Response and passes through rich result", () => {
  const r = new Response("x");
  const wrapped = normalizeExecutorResult(r);
  assert.equal(wrapped.response, r);
  assert.equal(wrapped.url, "");
  assert.deepEqual(wrapped.executionAttempts, [
    {
      index: 1,
      statusCode: r.status,
      outcome: "response",
      costAttribution: "unknown",
      attemptSource: "wrapper_observed",
    },
  ]);
  const rich = normalizeExecutorResult({ response: r, url: "u", headers: { a: "b" } });
  assert.equal(rich.url, "u");
  assert.equal(rich.headers.a, "b");
  assert.equal(rich.executionAttempts[0]?.attemptSource, "wrapper_observed");
  const attempts = normalizeExecutorResult({
    response: r,
    executionAttempts: [
      {
        index: 1,
        endpointIndex: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 3,
        statusCode: 200,
        outcome: "response",
        costAttribution: "unknown",
        attemptSource: "executor_reported",
      },
    ],
  });
  assert.equal(attempts.executionAttempts.length, 1);
  assert.equal(attempts.executionAttempts[0].statusCode, 200);
});

test("normalizeExecutorResult rejects malformed executor output", () => {
  assert.throws(() => normalizeExecutorResult({}), /must contain a Response/);
  assert.throws(
    () => normalizeExecutorResult({ response: "not-a-response" }),
    /must contain a Response/
  );
});
