import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDeterministicProviderAlias,
  DETERMINISTIC_CODESRAL_ALIASES,
  getDeterministicProviderRoute,
  resolveDeterministicCodestralRouteFromConnections,
} from "../../src/lib/deterministicProviderRoutes.ts";
import { resolveKeyForRequest } from "../../open-sse/services/apiKeyRotator.ts";
import { withDeterministicRouteHeaders } from "../../src/sse/handlers/chatHelpers.ts";

const CONNECTIONS = [
  {
    id: "connection-a",
    apiKey: "secret-a",
    providerSpecificData: { extraApiKeys: [] },
  },
  {
    id: "connection-b",
    apiKey: "secret-b",
    providerSpecificData: { extraApiKeys: [] },
  },
];

test("deterministic aliases map to stable account A and B candidates", () => {
  const accountA = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountA,
    CONNECTIONS
  );
  const accountB = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountB,
    CONNECTIONS
  );

  assert.equal(accountA?.connectionId, "connection-a");
  assert.equal(accountA?.keySlot, "primary");
  assert.equal(accountA?.credentialAlias, "codestral-account-a");
  assert.equal(accountB?.connectionId, "connection-b");
  assert.equal(accountB?.keySlot, "primary");
  assert.equal(accountB?.credentialAlias, "codestral-account-b");
  assert.equal(accountA?.servedModel, "mistral/codestral-latest");
  assert.equal(accountB?.servedModel, "mistral/codestral-latest");
});

test("account B can resolve to the second key on one configured connection", () => {
  const route = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountB,
    [
      {
        id: "connection-a",
        apiKey: "secret-a",
        providerSpecificData: { extraApiKeys: ["secret-b"] },
      },
    ]
  );

  assert.equal(route?.available, true);
  assert.equal(route?.connectionId, "connection-a");
  assert.equal(route?.keySlot, "extra_0");
});

test("deterministic routes fail closed and never cross-fail over", () => {
  const unavailable = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountB,
    [{ id: "connection-a", apiKey: "secret-a", providerSpecificData: {} }]
  );
  assert.equal(unavailable?.available, false);
  assert.equal(unavailable?.connectionId, null);

  const strictMissing = resolveKeyForRequest(
    "connection-a",
    "secret-a",
    ["secret-b"],
    "extra_1",
    true
  );
  assert.equal(strictMissing, null);
});

test("normal key selection remains load-balanced when strict routing is off", () => {
  const first = resolveKeyForRequest("load-balanced-test", "secret-a", ["secret-b"], null);
  const second = resolveKeyForRequest("load-balanced-test", "secret-a", ["secret-b"], null);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first?.keyId, second?.keyId);
});

test("route identity is non-secret and preserves streaming/tool fields", async () => {
  const route = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountA,
    CONNECTIONS
  );
  assert.ok(route);

  const body: Record<string, unknown> = {
    model: DETERMINISTIC_CODESRAL_ALIASES.accountA,
    stream: true,
    tools: [{ type: "function", function: { name: "lookup" } }],
  };
  applyDeterministicProviderAlias(body, route);
  assert.equal(body.model, "mistral/codestral-latest");
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: "function", function: { name: "lookup" } }]);
  assert.equal(getDeterministicProviderRoute(body)?.credentialAlias, "codestral-account-a");
  assert.equal(JSON.stringify(body).includes("secret-"), false);

  const response = withDeterministicRouteHeaders(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"tool_calls":[]}\n\n'));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    ),
    route
  );
  assert.equal(response.headers.get("X-OmniRoute-Route-Id"), "mistral-codestral-account-a");
  assert.equal(
    response.headers.get("X-OmniRoute-Requested-Model"),
    DETERMINISTIC_CODESRAL_ALIASES.accountA
  );
  assert.equal(response.headers.get("X-OmniRoute-Served-Model"), "mistral/codestral-latest");
  assert.equal(response.headers.get("X-OmniRoute-Credential-Alias"), "codestral-account-a");
  assert.equal(response.headers.get("X-OmniRoute-Key-Slot"), "primary");
  assert.equal(await response.text(), 'data: {"tool_calls":[]}\n\n');
  assert.equal(
    [...response.headers.values()].some((value) => value.includes("secret-")),
    false
  );
});
