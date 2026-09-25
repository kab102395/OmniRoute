import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDeterministicProviderAlias,
  DETERMINISTIC_CODESRAL_ALIASES,
  deterministicProviderRouteHeaders,
  getDeterministicProviderRoute,
  resolveDeterministicCodestralRouteFromConnections,
} from "../../src/lib/deterministicProviderRoutes.ts";
import {
  resetKeyStatus,
  resolveKeyForRequest,
  syncHealthFromDB,
} from "../../open-sse/services/apiKeyRotator.ts";
import { withDeterministicRouteHeaders } from "../../src/sse/handlers/chatHelpers.ts";
import { withEarlyStreamKeepalive } from "../../open-sse/utils/earlyStreamKeepalive.ts";
import { enforceOdysseusPolicy } from "../../src/lib/odysseus/routeGuard.ts";

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

test("a terminal primary slot disables A without poisoning pinned extra_0 B", () => {
  const connections = [
    {
      id: "shared-connection",
      apiKey: "secret-primary",
      providerSpecificData: {
        extraApiKeys: ["secret-extra"],
        apiKeyHealth: { primary: { status: "invalid" } },
      },
    },
  ];
  const accountA = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountA,
    connections
  );
  const accountB = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountB,
    connections
  );

  assert.equal(accountA?.available, false);
  assert.equal(accountA?.connectionId, "shared-connection");
  assert.equal(accountA?.keySlot, "primary");
  assert.equal(accountB?.available, true);
  assert.equal(accountB?.connectionId, "shared-connection");
  assert.equal(accountB?.keySlot, "extra_0");

  syncHealthFromDB("shared-connection", {
    primary: {
      status: "invalid",
      failures: 2,
      lastFailure: null,
      lastSuccess: null,
      totalRequests: 1,
      totalFailures: 1,
    },
  });
  assert.equal(
    resolveKeyForRequest("shared-connection", "secret-primary", ["secret-extra"], "primary", true),
    null,
    "pinned A must not fall back to B's extra key"
  );
  assert.equal(
    resolveKeyForRequest("shared-connection", "secret-primary", ["secret-extra"], "extra_0", true)
      ?.keyId,
    "extra_0"
  );
  resetKeyStatus("shared-connection", "primary");
  resetKeyStatus("shared-connection", "extra_0");
});

test("a terminal extra_0 slot disables B without poisoning pinned primary A", () => {
  const connections = [
    {
      id: "shared-connection-inverse",
      apiKey: "secret-primary",
      providerSpecificData: {
        extraApiKeys: ["secret-extra"],
        apiKeyHealth: { extra_0: { status: "invalid" } },
      },
    },
  ];
  const accountA = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountA,
    connections
  );
  const accountB = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountB,
    connections
  );

  assert.equal(accountA?.available, true);
  assert.equal(accountA?.keySlot, "primary");
  assert.equal(accountB?.available, false);
  assert.equal(accountB?.keySlot, "extra_0");
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
  assert.equal(response.headers.get("X-OmniRoute-Connection-Id"), "connection-a");
  assert.equal(await response.text(), 'data: {"tool_calls":[]}\n\n');
  assert.equal(
    [...response.headers.values()].some((value) => value.includes("secret-")),
    false
  );
});

test("pinned route identity survives the slow streaming keepalive response path", async () => {
  const route = resolveDeterministicCodestralRouteFromConnections(
    DETERMINISTIC_CODESRAL_ALIASES.accountB,
    [
      {
        id: "shared-connection",
        apiKey: "secret-primary",
        providerSpecificData: { extraApiKeys: ["secret-extra"] },
      },
    ]
  );
  assert.ok(route);

  const response = await withEarlyStreamKeepalive(
    new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(
          withDeterministicRouteHeaders(
            new Response("data: [DONE]\n\n", {
              headers: { "content-type": "text/event-stream" },
            }),
            route
          )
        );
      }, 20);
    }),
    {
      thresholdMs: 0,
      intervalMs: 250,
      extraHeaders: {
        ...deterministicProviderRouteHeaders(route),
        "X-Correlation-Id": "correlation-test",
      },
    }
  );

  assert.equal(response.headers.get("X-OmniRoute-Route-Id"), "mistral-codestral-account-b");
  assert.equal(response.headers.get("X-OmniRoute-Credential-Alias"), "codestral-account-b");
  assert.equal(response.headers.get("X-OmniRoute-Key-Slot"), "extra_0");
  assert.equal(response.headers.get("X-OmniRoute-Served-Model"), "mistral/codestral-latest");
  assert.equal(response.headers.get("X-Correlation-Id"), "correlation-test");
  assert.equal((await response.text()).includes("[DONE]"), true);
  assert.equal(
    [...response.headers.values()].some((value) => value.includes("secret-")),
    false
  );
});

test("Odysseus policy projection preserves deterministic route identity", () => {
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
  assert.ok(route);
  const body: Record<string, unknown> = { model: DETERMINISTIC_CODESRAL_ALIASES.accountB };
  applyDeterministicProviderAlias(body, route);

  const projected = enforceOdysseusPolicy(new Headers(), body);
  const projectedRoute = getDeterministicProviderRoute(projected.body);
  assert.equal(projectedRoute?.routeId, "mistral-codestral-account-b");
  assert.equal(projectedRoute?.credentialAlias, "codestral-account-b");
  assert.equal(projectedRoute?.keySlot, "extra_0");
  assert.equal(projectedRoute?.connectionId, "connection-a");
  assert.equal(JSON.stringify(projected.body).includes("secret-"), false);
});

test("A/B route headers preserve distinct logical and credential identities on cache paths", () => {
  const routes = [
    resolveDeterministicCodestralRouteFromConnections(DETERMINISTIC_CODESRAL_ALIASES.accountA, [
      {
        id: "connection-a",
        apiKey: "secret-a",
        providerSpecificData: { extraApiKeys: ["secret-b"] },
      },
    ]),
    resolveDeterministicCodestralRouteFromConnections(DETERMINISTIC_CODESRAL_ALIASES.accountB, [
      {
        id: "connection-a",
        apiKey: "secret-a",
        providerSpecificData: { extraApiKeys: ["secret-b"] },
      },
    ]),
  ];
  assert.ok(routes[0]);
  assert.ok(routes[1]);
  const hit = withDeterministicRouteHeaders(
    new Response("hit", { headers: { "X-OmniRoute-Cache": "HIT" } }),
    routes[0]
  );
  const miss = withDeterministicRouteHeaders(
    new Response("miss", { headers: { "X-OmniRoute-Cache": "MISS" } }),
    routes[1]
  );
  assert.notEqual(
    hit.headers.get("X-OmniRoute-Route-Id"),
    miss.headers.get("X-OmniRoute-Route-Id")
  );
  assert.notEqual(
    hit.headers.get("X-OmniRoute-Credential-Alias"),
    miss.headers.get("X-OmniRoute-Credential-Alias")
  );
  assert.equal(hit.headers.get("X-OmniRoute-Cache"), "HIT");
  assert.equal(miss.headers.get("X-OmniRoute-Cache"), "MISS");
  assert.equal(
    [...hit.headers.values()].some((value) => value.includes("secret-")),
    false
  );
  assert.equal(
    [...miss.headers.values()].some((value) => value.includes("secret-")),
    false
  );
});
