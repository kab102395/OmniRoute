import test from "node:test";
import assert from "node:assert/strict";

import { FreebuffExecutor } from "../../open-sse/executors/freebuff.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";
import {
  FREEBUFF_MODEL_COMPATIBILITY,
  freebuffProvider,
} from "../../open-sse/config/providers/registry/freebuff/index.ts";
import { APIKEY_PROVIDERS_GATEWAYS } from "../../src/shared/constants/providers/apikey/gateways.ts";
import { validateFreebuffProvider } from "../../src/lib/providers/validation.ts";

test("FreebuffExecutor: constructor initializes provider name correctly", () => {
  const executor = new FreebuffExecutor();
  assert.equal(executor.getProvider(), "freebuff");
});

test("FreebuffExecutor: returns 401 response when credentials are missing", async () => {
  const executor = new FreebuffExecutor();
  const res = await executor.execute({
    model: "deepseek/deepseek-v4-flash",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: { apiKey: "" },
  } as unknown as ExecuteInput);

  assert.equal(res.response.status, 401);
  const data = (await res.response.json()) as { error: { message: string } };
  assert.match(data.error.message, /Freebuff Auth Token required/i);
});

test("FreebuffExecutor: sanitizes and bounds session-admission error text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(`authorization failed: Bearer secret-token ${"upstream detail ".repeat(80)}`, {
      status: 402,
    })) as typeof fetch;

  try {
    const executor = new FreebuffExecutor();
    const result = await executor.execute({
      model: "deepseek/deepseek-v4-flash",
      body: { messages: [] },
      credentials: { apiKey: "local-test-credential" },
    } as unknown as ExecuteInput);
    const body = (await result.response.json()) as { error: { message: string } };
    assert.equal(result.response.status, 402);
    assert.ok(body.error.message.length < 700);
    assert.doesNotMatch(body.error.message, /secret-token|local-test-credential/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FreebuffExecutor: classifies typed admission refusals and never dispatches inference", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    ["rate_limited", 429, "NO_CAPACITY"],
    ["spend_limited", 403, "NO_CAPACITY"],
    ["ip_capped", 429, "NO_CAPACITY"],
    ["purchase_capacity", 409, "NO_CAPACITY"],
    ["premium_slot_taken", 409, "NO_CAPACITY"],
    ["banned", 403, "ACCOUNT_RESTRICTED"],
    ["country_blocked", 403, "ACCOUNT_RESTRICTED"],
    ["model_unavailable", 409, "MODEL_RESTRICTED"],
    ["consent_required", 409, "CONSENT_REQUIRED"],
    ["model_locked", 409, "SESSION_CONFLICT"],
    ["purchase_in_use", 409, "SESSION_CONFLICT"],
    ["first_tab_discount_changed", 200, "UNKNOWN"],
  ] as const;
  try {
    for (const [upstreamStatus, httpStatus, classification] of cases) {
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ status: upstreamStatus }, { status: httpStatus });
      }) as typeof fetch;
      const result = await new FreebuffExecutor().execute({
        model: "deepseek/deepseek-v4-flash",
        body: { messages: [] },
        credentials: { apiKey: "test-token" },
      } as unknown as ExecuteInput);
      assert.equal(result.response.status, httpStatus === 200 ? 502 : httpStatus, upstreamStatus);
      const body = (await result.response.json()) as { error: { code: string; type: string } };
      assert.equal(body.error.code, upstreamStatus);
      assert.equal(body.error.type, `freebuff_admission_${classification.toLowerCase()}`);
      assert.equal(calls.length, 1, `${upstreamStatus} must stop before agent/completion calls`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FreebuffExecutor: acquires an instance and dispatches one completion without live calls", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const observations: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/freebuff/session/admission")) {
      return Response.json({
        status: "active",
        instanceId: "test-instance",
        model: "deepseek/deepseek-v4-flash",
        admittedAt: "2026-09-25T10:00:00Z",
        expiresAt: "2026-09-25T11:00:00Z",
        remainingMs: 3_600_000,
        freebucks: {
          balance: 20,
          daily: { limit: 10, spent: 2, remaining: 8, resetAt: "2026-09-26T07:00:00Z" },
          wallet: { balance: 10 },
          prices: { "deepseek/deepseek-v4-flash": 3 },
        },
      });
    }
    if (url.endsWith("/agent-runs")) {
      return Response.json({ runId: "test-run" });
    }
    if (url.endsWith("/chat/completions")) {
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected Freebuff URL: ${url}`);
  }) as typeof fetch;

  try {
    const executor = new FreebuffExecutor();
    const result = await executor.execute({
      model: "deepseek/deepseek-v4-flash",
      body: { messages: [{ role: "user", content: "mocked request" }] },
      stream: false,
      credentials: { apiKey: "test-token" },
      log: { info: (_tag, message) => observations.push(message) },
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.deepEqual(
      calls.map(({ url }) => url.split("/api/v1")[1]),
      ["/freebuff/session/admission", "/agent-runs", "/chat/completions", "/agent-runs"]
    );
    assert.equal(calls[0]?.init?.method, "POST");
    const sessionHeaders = new Headers(calls[0]?.init?.headers);
    assert.equal(sessionHeaders.get("x-freebuff-model"), "deepseek/deepseek-v4-flash");
    assert.equal(sessionHeaders.get("x-freebuff-first-tab-discount"), "0");
    assert.equal(sessionHeaders.get("x-freebuff-wallet-spend-limit"), "0");
    assert.equal(sessionHeaders.has("x-freebuff-multi-session"), false);
    assert.equal(sessionHeaders.has("x-freebuff-desktop-attempt-id"), false);
    assert.equal(calls[0]?.init?.body, undefined);
    const completionHeaders = new Headers(calls[2]?.init?.headers);
    assert.equal(completionHeaders.get("x-freebuff-instance-id"), "test-instance");
    assert.equal(completionHeaders.get("x-codebuff-run-id"), "test-run");
    const completionBody = JSON.parse(String(calls[2]?.init?.body)) as {
      codebuff_metadata: Record<string, unknown>;
      model: string;
      stream: boolean;
    };
    assert.equal(completionBody.model, "deepseek/deepseek-v4-flash");
    assert.equal(completionBody.stream, false);
    assert.equal(completionBody.codebuff_metadata.freebuff_instance_id, "test-instance");
    assert.equal(completionBody.codebuff_metadata.run_id, "test-run");
    const observation = observations.find((message) => message.includes("OBSERVED_UPSTREAM")) || "";
    assert.ok(observation);
    assert.match(observation, /"daily"/);
    assert.doesNotMatch(observation, /test-instance|test-token/);
    const finishBody = JSON.parse(String(calls[3]?.init?.body)) as Record<string, unknown>;
    assert.equal(finishBody.action, "FINISH");
    assert.equal(finishBody.runId, "test-run");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("FreebuffExecutor: agent-run start failure does not prevent the completion request", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/freebuff/session/admission"))
      return Response.json({ status: "active", instanceId: "instance" });
    if (url.endsWith("/agent-runs")) return new Response("unavailable", { status: 503 });
    if (url.endsWith("/chat/completions")) return new Response("{}", { status: 200 });
    throw new Error(`Unexpected Freebuff URL: ${url}`);
  }) as typeof fetch;

  try {
    const executor = new FreebuffExecutor();
    const result = await executor.execute({
      model: "minimax/minimax-m3",
      body: { messages: [{ role: "user", content: "mocked request" }] },
      stream: true,
      credentials: { apiKey: "test-token" },
    } as unknown as ExecuteInput);
    assert.equal(result.response.status, 200);
    assert.equal(calls.filter((url) => url.endsWith("/agent-runs")).length, 1);
    assert.ok(calls.some((url) => url.endsWith("/chat/completions")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("freebuffProvider: registry entry has valid structure and catalog", () => {
  assert.equal(freebuffProvider.id, "freebuff");
  assert.equal(freebuffProvider.format, "openai");
  assert.equal(freebuffProvider.executor, "freebuff");
  assert.equal(freebuffProvider.baseUrl, "https://www.codebuff.com/api/v1");
  assert.ok(Array.isArray(freebuffProvider.models));
  assert.ok(freebuffProvider.models.length >= 8);

  const flash = freebuffProvider.models.find((m) => m.id === "deepseek/deepseek-v4-flash");
  assert.ok(flash, "deepseek/deepseek-v4-flash must exist in freebuff models");
  assert.equal(flash?.supportsReasoning, true);

  const minimax = freebuffProvider.models.find((m) => m.id === "minimax/minimax-m3");
  assert.ok(minimax, "minimax/minimax-m3 must exist in freebuff models");
  assert.equal(minimax?.supportsVision, true);
  assert.deepEqual(
    Object.keys(FREEBUFF_MODEL_COMPATIBILITY).sort(),
    freebuffProvider.models.map((model) => model.id).sort()
  );
  assert.equal(FREEBUFF_MODEL_COMPATIBILITY["mimo/mimo-v2.5"], "STABLE_LEGACY_WIRE");
  assert.equal(FREEBUFF_MODEL_COMPATIBILITY["crof/kimi-k3-eco"], "UNKNOWN_COMPATIBILITY");
});

test("APIKEY_PROVIDERS_GATEWAYS: freebuff gateway metadata is defined", () => {
  const fb = APIKEY_PROVIDERS_GATEWAYS.freebuff;
  assert.ok(fb, "freebuff must be in APIKEY_PROVIDERS_GATEWAYS");
  assert.equal(fb.id, "freebuff");
  assert.equal(fb.name, "Freebuff");
  assert.equal(fb.color, "#10B981");
  assert.equal(fb.hasFree, true);
});

test("validateFreebuffProvider: returns invalid when apiKey is empty", async () => {
  const res = await validateFreebuffProvider({ apiKey: "" });
  assert.equal(res.valid, false);
  assert.match(res.error || "", /Freebuff Auth Token required/i);
});

test("validateFreebuffProvider: uses read-only GET and accepts no-session state", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(input), init };
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const result = await validateFreebuffProvider({ apiKey: "test-token" });
    assert.equal(result.valid, true);
    assert.equal(request?.url, "https://codebuff.com/api/v1/freebuff/session");
    assert.equal(request?.init?.method, "GET");
    assert.equal(new Headers(request?.init?.headers).has("x-freebuff-model"), false);
    assert.equal(request?.init?.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateFreebuffProvider: accepts valid auth even when capacity is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      status: "none",
      freebucks: { balance: 0, daily: { limit: 10, remaining: 0 } },
    })) as typeof fetch;
  try {
    assert.equal((await validateFreebuffProvider({ apiKey: "test-token" })).valid, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateFreebuffProvider: distinguishes rejected auth and account restrictions", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    assert.equal((await validateFreebuffProvider({ apiKey: "test-token" })).valid, false);
    for (const status of ["banned", "country_blocked"]) {
      globalThis.fetch = (async () => Response.json({ status }, { status: 403 })) as typeof fetch;
      const result = await validateFreebuffProvider({ apiKey: "test-token" });
      assert.equal(result.valid, true);
      assert.match(result.warning || "", new RegExp(status));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateFreebuffProvider: treats upstream and network failures as inconclusive", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    let result = await validateFreebuffProvider({ apiKey: "test-token" });
    assert.equal(result.valid, true);
    assert.match(result.warning || "", /inconclusive/i);
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    result = await validateFreebuffProvider({ apiKey: "test-token" });
    assert.equal(result.valid, true);
    assert.match(result.warning || "", /inconclusive/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
