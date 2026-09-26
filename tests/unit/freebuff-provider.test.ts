import test from "node:test";
import assert from "node:assert/strict";

import { FreebuffExecutor } from "../../open-sse/executors/freebuff.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";
import { freebuffProvider } from "../../open-sse/config/providers/registry/freebuff/index.ts";
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

test("FreebuffExecutor: acquires an instance and dispatches one completion without live calls", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/freebuff/session")) {
      return Response.json({ instanceId: "test-instance" });
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
    } as unknown as ExecuteInput);

    assert.equal(result.response.status, 200);
    assert.deepEqual(
      calls.map(({ url }) => url.split("/api/v1")[1]),
      ["/freebuff/session", "/agent-runs", "/chat/completions", "/agent-runs"]
    );
    const sessionHeaders = new Headers(calls[0]?.init?.headers);
    assert.equal(sessionHeaders.get("x-freebuff-model"), "deepseek/deepseek-v4-flash");
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
    if (url.endsWith("/freebuff/session")) return Response.json({ instanceId: "instance" });
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
