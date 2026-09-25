import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-route-stream-http-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const originalPluginsDir = process.env.OMNIROUTE_PLUGINS_DIR;
const TEST_PLUGINS_DIR = path.join(TEST_DATA_DIR, "plugins");
process.env.OMNIROUTE_PLUGINS_DIR = TEST_PLUGINS_DIR;
fs.mkdirSync(TEST_PLUGINS_DIR, { recursive: true });

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;

test("HTTP chat route preserves pinned RouteIdentity on delayed streaming responses", async () => {
  await providersDb.createProviderConnection({
    provider: "mistral",
    authType: "apikey",
    name: "route-identity-stream-test",
    apiKey: "disposable-test-primary-key",
    providerSpecificData: { extraApiKeys: ["disposable-test-extra-key"] },
    isActive: true,
    testStatus: "active",
  });

  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    return new Response(
      [
        'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  };

  try {
    const response = await chatRoute.POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: "mistral/codestral-account-b",
          messages: [{ role: "user", content: "Return OK" }],
          max_tokens: 8,
          stream: true,
        }),
      })
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-OmniRoute-Route-Id"), "mistral-codestral-account-b");
    assert.equal(
      response.headers.get("X-OmniRoute-Requested-Model"),
      "mistral/codestral-account-b"
    );
    assert.equal(response.headers.get("X-OmniRoute-Served-Model"), "mistral/codestral-latest");
    assert.equal(response.headers.get("X-OmniRoute-Provider"), "mistral");
    assert.equal(response.headers.get("X-OmniRoute-Credential-Alias"), "codestral-account-b");
    assert.equal(response.headers.get("X-OmniRoute-Key-Slot"), "extra_0");
    assert.equal(await response.text().then((body) => body.includes("[DONE]")), true);
    assert.equal(upstreamCalls, 1);
    assert.equal(
      [...response.headers.values()].some((value) => value.includes("disposable-test-")),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  core.resetDbInstance();
  if (originalPluginsDir === undefined) delete process.env.OMNIROUTE_PLUGINS_DIR;
  else process.env.OMNIROUTE_PLUGINS_DIR = originalPluginsDir;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
