import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-model-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";
const REAL_FETCH = globalThis.fetch;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const featureFlagsDb = await import("../../src/lib/db/featureFlags.ts");
const modelsDevSync = await import("../../src/lib/modelsDevSync.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const { normalizeOpenAiLikeModelsResponse } =
  await import("../../src/app/api/providers/[id]/models/discovery/normalizers.ts");
const { persistDiscoveredModels } = await import("../../src/lib/providerModels/modelDiscovery.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // #6408 added a 1.5s TTL response cache to getUnifiedModelsResponse keyed only by
  // (prefix, isCodex client, apiKey) — NOT by DB/settings state. Without clearing it
  // between test cases, a test running within the TTL window of a previous one gets
  // served the previous test's stale serialized catalog instead of a fresh build.
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
}

async function seedConnection(provider: string, overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider,
    authType: (overrides.authType as string) || "apikey",
    name: (overrides.name as string) || `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: (overrides.apiKey as string) || "sk-test",
    accessToken: overrides.accessToken as string | undefined,
    isActive: (overrides.isActive as boolean) ?? true,
    testStatus: (overrides.testStatus as string) || "active",
    providerSpecificData: (overrides.providerSpecificData as Record<string, unknown>) || {},
  });
}

function capability(overrides = {}) {
  return {
    tool_call: null,
    reasoning: null,
    attachment: null,
    structured_output: null,
    temperature: null,
    modalities_input: JSON.stringify([]),
    modalities_output: JSON.stringify([]),
    knowledge_cutoff: null,
    release_date: null,
    last_updated: null,
    status: null,
    family: null,
    open_weights: null,
    limit_context: null,
    limit_input: null,
    limit_output: null,
    interleaved_field: null,
    ...overrides,
  };
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("v1 models catalog requires auth when the route is protected and login is enabled", async () => {
  featureFlagsDb.setFeatureFlagOverride("REQUIRE_API_KEY", "true");
  await settingsDb.updateSettings({
    requireLogin: true,
    password: "hashed-password",
    requireAuthForModels: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "invalid_api_key");
  assert.match(body.error.message, /Authentication required/i);
});

test("v1 models catalog accepts bearer API keys and filters the list by allowed model patterns", async () => {
  await settingsDb.updateSettings({
    requireLogin: true,
    password: "hashed-password",
    requireAuthForModels: true,
  });
  await seedConnection("openai", { name: "openai-main" });
  await seedConnection("claude", {
    authType: "oauth",
    name: "claude-main",
    apiKey: null,
    accessToken: "claude-access",
  });

  const key = await apiKeysDb.createApiKey("catalog-filter", "machine-catalog");
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedModels: ["openai/*"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", {
      headers: { Authorization: `Bearer ${key.key}` },
    })
  );
  const body = (await response.json()) as any;
  const ids = body.data.map((item) => item.id);

  assert.equal(response.status, 200);
  assert.ok(ids.some((id) => id.startsWith("openai/")));
  assert.equal(
    ids.some((id) => id.startsWith("claude/") || id.startsWith("cc/")),
    false
  );
});

test("v1 models catalog does NOT accept API keys supplied via query string (#3300 security follow-up)", async () => {
  // Query-string token fallbacks (`?token=`/`?key=`/`?apiKey=`/`?api_key=`) were
  // intentionally removed — a credential in the query string leaks into access
  // logs / Referer headers. The VS Code integration uses the path-scoped
  // `/vscode/<token>/…` form instead (covered by the next test). So a `?token=`
  // on the catalog route is no longer a usable credential → auth fails.
  featureFlagsDb.setFeatureFlagOverride("REQUIRE_API_KEY", "true");
  await settingsDb.updateSettings({
    requireLogin: true,
    password: "hashed-password",
    requireAuthForModels: true,
  });
  await seedConnection("openai", { name: "openai-query-auth" });

  const key = await apiKeysDb.createApiKey("catalog-query-auth", "machine-catalog-query");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request(`http://localhost/api/v1/models?token=${encodeURIComponent(key.key)}`)
  );

  assert.equal(response.status, 401);
});

test("v1 models catalog accepts API keys embedded in vscode path aliases when auth is required", async () => {
  await settingsDb.updateSettings({
    requireLogin: true,
    password: "hashed-password",
    requireAuthForModels: true,
  });
  await seedConnection("openai", { name: "openai-path-auth" });

  const key = await apiKeysDb.createApiKey("catalog-path-auth", "machine-catalog-path");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request(`http://localhost/api/v1/vscode/${encodeURIComponent(key.key)}/models`)
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length > 0);
});

test("v1 models catalog includes display names by default", async () => {
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const model = body.data.find((item) => item.id === "oc/big-pickle");

  assert.equal(response.status, 200);
  assert.ok(model);
  assert.equal(model.name, "Big Pickle");
});

test("v1 models catalog omits display names when the feature flag is disabled", async () => {
  featureFlagsDb.setFeatureFlagOverride("MODEL_CATALOG_INCLUDE_NAMES", "false");

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const model = body.data.find((item) => item.id === "oc/big-pickle");

    assert.equal(response.status, 200);
    assert.ok(model);
    assert.equal("name" in model, false);
    assert.equal(model.root, "big-pickle");
  } finally {
    featureFlagsDb.removeFeatureFlagOverride("MODEL_CATALOG_INCLUDE_NAMES");
  }
});

test("v1 models catalog hides models excluded by every active connection while keeping models served by at least one account", async () => {
  const first = await seedConnection("openai", {
    name: "openai-first",
    providerSpecificData: {
      excludedModels: ["gpt-5.4*"],
    },
  });
  const second = await seedConnection("openai", {
    name: "openai-second",
    providerSpecificData: {
      excludedModels: ["gpt-4.1*"],
    },
  });

  let response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  let body = (await response.json()) as any;
  let ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.equal(ids.has("openai/gpt-5.4-mini"), true);

  await providersDb.updateProviderConnection((second as any).id, {
    providerSpecificData: {
      excludedModels: ["gpt-5.4*"],
    },
  });

  response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  body = (await response.json()) as any;
  ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.equal(ids.has("openai/gpt-5.4-mini"), false);

  await providersDb.updateProviderConnection((first as any).id, {
    providerSpecificData: {
      excludedModels: [],
    },
  });
});

test("v1 models catalog includes combos and custom models while excluding hidden models and blocked providers", async () => {
  await settingsDb.updateSettings({
    blockedProviders: ["claude"],
  });
  await seedConnection("openai", { name: "openai-visible" });
  await seedConnection("claude", {
    authType: "oauth",
    name: "claude-blocked",
    apiKey: null,
    accessToken: "claude-access",
  });
  await seedConnection("kiro", {
    authType: "oauth",
    name: "kiro-custom",
    apiKey: null,
    accessToken: "kiro-access",
  });

  modelsDb.mergeModelCompatOverride("openai", "gpt-4o-mini", { isHidden: true });
  await modelsDb.addCustomModel("kiro", "custom-kiro", "Custom Kiro");
  await combosDb.createCombo({
    name: "team-router",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.ok(ids.has("team-router"));
  assert.ok(ids.has("kr/custom-kiro"));
  assert.ok(ids.has("kiro/custom-kiro"));
  assert.equal(ids.has("openai/gpt-4o-mini"), false);
  assert.equal(
    [...ids].some((id) => (id as any).startsWith("claude/") || (id as any).startsWith("cc/")),
    false
  );
});

test("v1 models catalog keeps only visible combos when no providers are active", async () => {
  const visible = await combosDb.createCombo({
    name: "visible-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });
  await combosDb.updateCombo((visible as any).id, { context_length: 32000 });
  const hidden = await combosDb.createCombo({
    name: "hidden-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
    isHidden: true,
  });
  const inactive = await combosDb.createCombo({
    name: "inactive-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });
  await combosDb.updateCombo((inactive as any).id, { isActive: false });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  // The visible combo must be present (noAuth provider models may also appear — that is correct
  // behavior after the fix for Issue #2798, so we check membership rather than exact equality).
  const ids = body.data.map((item) => item.id);
  assert.ok(ids.includes(visible.name), "visible combo must appear");
  const visibleCombo = body.data.find((item) => item.id === visible.name);
  assert.ok(visibleCombo, "visible combo entry must exist");
  assert.equal(visibleCombo.context_length, 32000);
  assert.equal(
    body.data.some((item) => item.id === hidden.name),
    false
  );
  assert.equal(
    body.data.some((item) => item.id === inactive.name),
    false
  );
});

test("v1 models catalog derives combo metadata from known targets conservatively", async () => {
  try {
    modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "combo-alpha": capability({
          tool_call: true,
          reasoning: true,
          attachment: true,
          structured_output: true,
          temperature: false,
          modalities_input: JSON.stringify(["text", "image"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 1000,
          limit_input: 900,
          limit_output: 120,
        }),
      },
      gemini: {
        "combo-beta": capability({
          tool_call: true,
          reasoning: true,
          attachment: false,
          structured_output: true,
          temperature: false,
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 800,
          limit_input: 700,
          limit_output: 90,
        }),
      },
    });

    await combosDb.createCombo({
      name: "metadata-router",
      strategy: "priority",
      models: ["openai/combo-alpha", "gemini/combo-beta"],
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const combo = body.data.find((item) => item.id === "metadata-router");

    assert.equal(response.status, 200);
    assert.ok(combo);
    assert.equal(combo.context_length, 800);
    assert.equal(combo.max_input_tokens, 700);
    assert.equal(combo.max_output_tokens, 90);
    assert.deepEqual(combo.input_modalities, ["text"]);
    assert.deepEqual(combo.output_modalities, ["text"]);
    assert.equal(combo.capabilities.structured_output, true);
    assert.equal(combo.capabilities.temperature, false);
    assert.equal(combo.capabilities.tool_calling, true);
    assert.equal(combo.capabilities.reasoning, true);
    assert.equal(combo.capabilities.thinking, true);
    assert.equal("vision" in combo.capabilities, false);
    assert.equal("attachment" in combo.capabilities, false);
    assert.equal("architecture" in combo, false);
    assert.equal("top_provider" in combo, false);
    assert.equal("supported_parameters" in combo, false);
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog lets explicit combo context override derived context", async () => {
  try {
    modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "context-alpha": capability({
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 1000,
          limit_input: 900,
          limit_output: 120,
        }),
      },
      gemini: {
        "context-beta": capability({
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 800,
          limit_input: 700,
          limit_output: 90,
        }),
      },
    });

    const combo = await combosDb.createCombo({
      name: "context-router",
      strategy: "priority",
      models: ["openai/context-alpha", "gemini/context-beta"],
    });
    await combosDb.updateCombo((combo as any).id, { context_length: 12345 });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const listed = body.data.find((item) => item.id === "context-router");

    assert.equal(response.status, 200);
    assert.equal(listed.context_length, 12345);
    assert.equal(listed.max_input_tokens, 700);
    assert.equal(listed.max_output_tokens, 90);
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog keeps unknown combo targets visible without guessed metadata", async () => {
  await combosDb.createCombo({
    name: "unknown-router",
    strategy: "priority",
    models: ["openai/no-known-metadata"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const combo = body.data.find((item) => item.id === "unknown-router");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.equal("context_length" in combo, false);
  assert.equal("max_input_tokens" in combo, false);
  assert.equal("max_output_tokens" in combo, false);
  assert.equal("input_modalities" in combo, false);
  assert.equal("output_modalities" in combo, false);
  assert.equal("capabilities" in combo, false);
});

test("v1 models catalog aggregates nested combos and keeps hidden child combos unlisted", async () => {
  try {
    modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "nested-alpha": capability({
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 1000,
          limit_input: 900,
          limit_output: 120,
        }),
      },
      gemini: {
        "nested-beta": capability({
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 800,
          limit_input: 700,
          limit_output: 90,
        }),
      },
    });

    await combosDb.createCombo({
      name: "hidden-child-router",
      strategy: "priority",
      models: ["openai/nested-alpha", "gemini/nested-beta"],
      isHidden: true,
    });
    await combosDb.createCombo({
      name: "parent-router",
      strategy: "priority",
      models: ["hidden-child-router"],
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const parent = body.data.find((item) => item.id === "parent-router");

    assert.equal(response.status, 200);
    assert.ok(parent);
    assert.equal(parent.context_length, 800);
    assert.equal(parent.max_output_tokens, 90);
    assert.equal(
      body.data.some((item) => item.id === "hidden-child-router"),
      false
    );
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog resolves provider aliases without corrupting slashful model ids", async () => {
  try {
    modelsDevSync.saveModelsDevCapabilities({
      claude: {
        "alias-model": capability({
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 2000,
          limit_input: 1900,
          limit_output: 200,
        }),
      },
      openrouter: {
        "Qwen/Qwen3-Coder": capability({
          modalities_input: JSON.stringify(["text"]),
          modalities_output: JSON.stringify(["text"]),
          limit_context: 1600,
          limit_input: 1500,
          limit_output: 150,
        }),
      },
    });

    await combosDb.createCombo({
      name: "alias-and-slash-router",
      strategy: "priority",
      models: [
        { kind: "model", providerId: "claude", model: "cc/alias-model" },
        { kind: "model", providerId: "openrouter", model: "Qwen/Qwen3-Coder" },
      ],
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const combo = body.data.find((item) => item.id === "alias-and-slash-router");

    assert.equal(response.status, 200);
    assert.ok(combo);
    assert.equal(combo.context_length, 1600);
    assert.equal(combo.max_input_tokens, 1500);
    assert.equal(combo.max_output_tokens, 150);
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models exposes selectable exact OpenRouter free variants with their own capabilities", async () => {
  await seedConnection("openrouter");
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "openrouter/free",
            name: "Free Models Router",
            pricing: { prompt: "0", completion: "0" },
            supported_parameters: ["tools"],
          },
          {
            id: "vendor/coder:free",
            name: "Vendor Coder Free",
            context_length: 64000,
            top_provider: { max_completion_tokens: 4096 },
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["tools"],
          },
          {
            id: "vendor/coder",
            name: "Vendor Coder Paid",
            pricing: { prompt: "0.000001", completion: "0.000002" },
            supported_parameters: [],
          },
          {
            id: "vendor/explicit-zero",
            name: "Vendor Explicit Zero",
            pricing: { prompt: "0", completion: "0", image: "0", request: "0" },
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["tools"],
          },
          {
            id: "vendor/no-tools:free",
            name: "Vendor No Tools Free",
            supported_parameters: [],
          },
          {
            id: "vendor/unknown-tools:free",
            name: "Vendor Unknown Tools Free",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{
        id?: string;
        free?: boolean;
        route_selection?: { kind?: string; exactModelIdentity?: boolean };
        capabilities?: Record<string, boolean>;
        supported_parameters?: string[];
        capability_status?: {
          tool_calling?: { status?: string; source?: string };
        };
        context_length?: number;
        max_output_tokens?: number;
        pricing_provenance?: { zeroCostEligibility?: string };
        pricing?: { input?: number };
        route_availability?: {
          catalogListed?: boolean;
          accountEligibility?: string;
          source?: { id?: string; modelId?: string; stale?: boolean; cacheTtlMs?: number };
          downstreamHostSelection?: string;
        };
      }>;
    };
    const freeRoute = body.data.find((model) => model.id === "openrouter/vendor/coder:free");
    const paidRoute = body.data.find((model) => model.id === "openrouter/vendor/coder");
    const explicitZeroRoute = body.data.find(
      (model) => model.id === "openrouter/vendor/explicit-zero"
    );
    const noToolsRoute = body.data.find((model) => model.id === "openrouter/vendor/no-tools:free");
    const unknownToolsRoute = body.data.find(
      (model) => model.id === "openrouter/vendor/unknown-tools:free"
    );
    const freeRouter = body.data.find((model) => model.id === "openrouter/free");

    assert.ok(freeRoute, "the exact :free route must be individually selectable");
    assert.equal(freeRoute.free, true);
    assert.deepEqual(freeRoute.route_selection, {
      kind: "exact_model",
      exactModelIdentity: true,
    });
    assert.ok(freeRouter, "the optional OpenRouter free router is exposed separately");
    assert.deepEqual(freeRouter.route_selection, {
      kind: "dynamic_free_model",
      exactModelIdentity: false,
    });
    assert.equal(
      freeRouter.capability_status?.tool_calling?.status,
      "unknown",
      "router-wide tool parameters do not prove the randomly selected model supports tools"
    );
    assert.equal(freeRouter.capabilities?.tool_calling, undefined);
    assert.equal(freeRoute.capabilities.tool_calling, true);
    assert.deepEqual(freeRoute.supported_parameters, ["tools"]);
    assert.equal(freeRoute.context_length, 64000);
    assert.equal(freeRoute.max_output_tokens, 4096);
    assert.equal(freeRoute.pricing_provenance.zeroCostEligibility, "verified_free_variant");
    assert.equal(freeRoute.route_availability.catalogListed, true);
    assert.equal(freeRoute.route_availability.accountEligibility, "unknown");
    assert.equal(freeRoute.route_availability.source?.modelId, "vendor/coder:free");
    assert.equal(freeRoute.route_availability.source?.stale, false);
    assert.equal(freeRoute.route_availability.downstreamHostSelection, "aggregator_selected");
    assert.equal(explicitZeroRoute?.free, true);
    assert.equal(
      explicitZeroRoute?.pricing_provenance?.zeroCostEligibility,
      "verified_free_variant"
    );
    assert.equal(explicitZeroRoute?.capabilities?.tool_calling, true);
    assert.ok(paidRoute, "the paid sibling remains a separate selectable route");
    assert.equal(paidRoute.free, false);
    assert.equal(paidRoute.pricing.input, 1);
    assert.equal(noToolsRoute?.capabilities?.tool_calling, false);
    assert.deepEqual(noToolsRoute?.capability_status?.tool_calling, {
      status: "unsupported",
      source: "openrouter.models_api",
    });
    assert.deepEqual(unknownToolsRoute?.capability_status?.tool_calling, {
      status: "unknown",
      source: "unknown",
    });
    assert.equal(
      unknownToolsRoute?.capabilities?.tool_calling,
      undefined,
      "unknown route capability must not inherit a canonical-model boolean"
    );

    const configuredFreeResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models?free_only=true&configuredOnly=true")
    );
    const configuredFreeBody = (await configuredFreeResponse.json()) as {
      data: Array<{ id?: string }>;
    };
    assert.ok(
      configuredFreeBody.data.some((model) => model.id === "openrouter/vendor/no-tools:free"),
      "the unfiltered free-only catalog keeps the exact free route before capability filtering"
    );

    const toolCapableFreeResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request(
        "http://localhost/v1/models?free_only=true&require_tool_calling=true&configuredOnly=true"
      )
    );
    const toolCapableFreeBody = (await toolCapableFreeResponse.json()) as {
      data: Array<{ id?: string; capability_status?: { tool_calling?: { status?: string } } }>;
    };
    const toolCapableFreeIds = toolCapableFreeBody.data.map((model) => model.id);
    assert.ok(toolCapableFreeIds.includes("openrouter/vendor/coder:free"));
    assert.ok(toolCapableFreeIds.includes("openrouter/vendor/explicit-zero"));
    assert.equal(toolCapableFreeIds.includes("openrouter/vendor/coder"), false);
    assert.equal(toolCapableFreeIds.includes("openrouter/vendor/no-tools:free"), false);
    assert.equal(toolCapableFreeIds.includes("openrouter/vendor/unknown-tools:free"), false);
    assert.equal(toolCapableFreeIds.includes("openrouter/free"), false);
    assert.ok(
      toolCapableFreeBody.data.every(
        (model) => model.capability_status?.tool_calling?.status === "supported"
      )
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("OpenRouter's dynamic free router requires a fresh non-empty catalog and survives hide-paid", async () => {
  await seedConnection("openrouter");
  await settingsDb.updateSettings({ hidePaidModels: true });
  const openRouterCatalog = await import("../../src/lib/catalog/openrouterCatalog.ts");
  const modelsWithFreeRoute = [{ id: "vendor/current:free", supported_parameters: ["tools"] }];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: modelsWithFreeRoute }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    assert.equal((await openRouterCatalog.refreshOpenRouterCatalog()).ok, true);
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        free?: boolean;
        route_selection?: { kind?: string; exactModelIdentity?: boolean };
        route_availability?: { source?: { stale?: boolean } };
      }>;
    };
    const freeRouter = body.data.find((model) => model.id === "openrouter/free");

    assert.ok(freeRouter, "fresh free routes keep the optional selector visible");
    assert.equal(freeRouter.free, true);
    assert.deepEqual(freeRouter.route_selection, {
      kind: "dynamic_free_model",
      exactModelIdentity: false,
    });
    assert.equal(freeRouter.route_availability?.source?.stale, false);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    assert.equal((await openRouterCatalog.refreshOpenRouterCatalog()).ok, true);
    const emptyResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    const emptyBody = (await emptyResponse.json()) as { data: Array<{ id: string }> };
    assert.equal(
      emptyBody.data.some((model) => model.id === "openrouter/free"),
      false,
      "an empty current free catalog cannot authorize the dynamic selector"
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("v1 models exposes other providers' curated free-tier facts without claiming account eligibility", async () => {
  await seedConnection("groq");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models")
  );
  const body = (await response.json()) as {
    data: Array<{
      id?: string;
      free?: boolean;
      free_access?: {
        classification?: string;
        freeType?: string;
        monthlyTokens?: number;
        hardStopGuaranteed?: boolean | null;
        accountEligibility?: string;
        zeroCostOnExhaustion?: string;
        source?: { id?: string; freshness?: string; retrievedAt?: string | null };
      };
    }>;
  };
  const freeTierRoute = body.data.find((model) => model.id === "groq/openai/gpt-oss-120b");

  assert.ok(freeTierRoute, "the exact configured Groq route should be listed");
  assert.equal(freeTierRoute.free, undefined, "free-tier offering is not a zero-price assertion");
  assert.equal(freeTierRoute.free_access?.classification, "documented_free_tier");
  assert.equal(freeTierRoute.free_access?.freeType, "recurring-daily");
  assert.equal(freeTierRoute.free_access?.monthlyTokens, 6_000_000);
  assert.equal(freeTierRoute.free_access?.hardStopGuaranteed, true);
  assert.equal(freeTierRoute.free_access?.zeroCostOnExhaustion, "provider_hard_stop");
  assert.equal(freeTierRoute.free_access?.accountEligibility, "unknown");
  assert.equal(freeTierRoute.free_access?.source?.id, "omniroute.free_model_catalog");
  assert.equal(freeTierRoute.free_access?.source?.freshness, "release_catalog");
  assert.equal(freeTierRoute.free_access?.source?.retrievedAt, null);
});

test("v1 models free-only mode includes exact provider routes with guaranteed free-tier hard stops", async () => {
  await seedConnection("groq");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models?free_only=true")
  );
  const body = (await response.json()) as {
    data: Array<{
      id?: string;
      owned_by?: string;
      free?: boolean;
      free_access?: {
        hardStopGuaranteed?: boolean | null;
        zeroCostOnExhaustion?: string;
      };
    }>;
  };
  const routeIds = body.data.map((model) => model.id);

  assert.equal(response.status, 200);
  assert.ok(routeIds.includes("groq/openai/gpt-oss-120b"));
  assert.ok(
    body.data.every(
      (model) =>
        (model.owned_by === "openrouter" && model.free === true) ||
        (model.free_access?.hardStopGuaranteed === true &&
          model.free_access.zeroCostOnExhaustion === "provider_hard_stop")
    ),
    "free-only candidates must have current OpenRouter free-route evidence or a guaranteed provider hard stop"
  );
});

test("v1 models removes a retired synchronized OpenRouter free route in free-only mode", async () => {
  const connection = await seedConnection("openrouter");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", connection.id as string, [
    { id: "vendor/retired:free", name: "Retired free route", source: "imported" },
  ]);
  await settingsDb.updateSettings({ hidePaidModels: true });
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ data: [{ id: "vendor/current:free", supported_parameters: ["tools"] }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    const body = (await response.json()) as { data: Array<{ id: string; free?: boolean }> };
    assert.equal(response.status, 200);
    assert.equal(
      body.data.some((model) => model.id === "openrouter/vendor/retired:free"),
      false
    );
    assert.equal(
      body.data.find((model) => model.id === "openrouter/vendor/current:free")?.free,
      true
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("current OpenRouter paid metadata refreshes matching synchronized route identity", async () => {
  const connection = await seedConnection("openrouter");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", connection.id as string, [
    {
      id: "vendor/synced-paid",
      name: "Synced Vendor Paid",
      source: "imported",
      supportsTools: false,
      inputTokenLimit: 1000,
    },
  ]);
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "vendor/synced-paid",
            name: "Current Vendor Paid",
            context_length: 64000,
            top_provider: { max_completion_tokens: 4096 },
            pricing: { prompt: "0.000003", completion: "0.000005" },
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            supported_parameters: ["tools"],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        name?: string;
        capabilities?: Record<string, boolean>;
        context_length?: number;
        max_output_tokens?: number;
        pricing?: { input?: number; output?: number };
        pricing_provenance?: { state?: string; routeModelId?: string };
      }>;
    };
    const route = body.data.find((model) => model.id === "openrouter/vendor/synced-paid");

    assert.equal(response.status, 200);
    assert.ok(route);
    assert.equal(route.name, "Current Vendor Paid");
    assert.equal(route.pricing?.input, 3);
    assert.equal(route.pricing?.output, 5);
    assert.equal(route.capabilities?.tool_calling, true);
    assert.equal(route.context_length, 64000);
    assert.equal(route.max_output_tokens, 4096);
    assert.equal(route.pricing_provenance?.state, "reported");
    assert.equal(route.pricing_provenance?.routeModelId, "vendor/synced-paid");
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("current OpenRouter metadata does not retain capabilities from a synchronized route", async () => {
  const connection = await seedConnection("openrouter");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openrouter", connection.id as string, [
    {
      id: "anthropic/claude-3.5-sonnet",
      name: "Synced Claude route",
      source: "imported",
      supportsTools: true,
      supportsVision: true,
      inputTokenLimit: 200000,
    },
  ]);
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "anthropic/claude-3.5-sonnet",
            name: "Current Claude route",
            context_length: 200000,
            pricing: { prompt: "0.000003", completion: "0.000005" },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        capabilities?: Record<string, boolean>;
        capability_status?: { tool_calling?: { status?: string; source?: string } };
        supported_parameters?: string[];
        input_modalities?: string[];
      }>;
    };
    const route = body.data.find((model) => model.id === "openrouter/anthropic/claude-3.5-sonnet");

    assert.ok(route);
    assert.equal(route.capabilities?.tool_calling, undefined);
    assert.deepEqual(route.capability_status?.tool_calling, {
      status: "unknown",
      source: "unknown",
    });
    assert.equal(route.capabilities?.vision, undefined);
    assert.equal(route.supported_parameters, undefined);
    assert.equal(route.input_modalities, undefined);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("v1 models preserves Hugging Face provider-level capability and pricing facts with freshness", async () => {
  const connection = await seedConnection("huggingface");
  await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", connection.id as string, [
    {
      id: "fixture-org/route-metadata-model",
      name: "Route metadata fixture model",
      source: "imported",
      providerRoutes: [
        {
          provider: "together",
          status: "live",
          contextLength: 262144,
          pricing: { input: 1.4, output: 4.4 },
          isFree: false,
          supportsTools: true,
          supportsStructuredOutput: true,
        },
        { provider: "promo-host", status: "live", isFree: true, supportsTools: true },
      ],
      providerRoutesRetrievedAt: new Date().toISOString(),
    },
    {
      id: "zai-org/GLM-stale",
      name: "GLM stale catalog fixture",
      source: "imported",
      providerRoutes: [{ provider: "promo-host", status: "live", isFree: true }],
      providerRoutesRetrievedAt: "2020-01-01T00:00:00.000Z",
    },
  ]);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models")
  );
  const body = (await response.json()) as {
    data: Array<{
      id: string;
      provider_routes?: Array<{
        provider?: string;
        route_model?: string;
        status?: string;
        context_length?: number;
        pricing?: { input?: number; output?: number };
        is_free?: boolean;
        free_catalog_eligible?: boolean;
        supports_tools?: boolean;
      }>;
      provider_routes_provenance?: { source?: string; pricing_unit?: string; stale?: boolean };
      free?: boolean;
    }>;
  };
  const model = body.data.find((entry) => entry.id === "hf/fixture-org/route-metadata-model");

  assert.equal(response.status, 200);
  assert.ok(model);
  assert.equal(model.free, undefined, "a free downstream host does not make the router route free");
  assert.deepEqual(model.provider_routes, [
    {
      provider: "together",
      route_model: "hf/fixture-org/route-metadata-model:together",
      status: "live",
      context_length: 262144,
      pricing: { input: 1.4, output: 4.4 },
      is_free: false,
      free_catalog_eligible: false,
      supports_tools: true,
      supports_structured_output: true,
    },
    {
      provider: "promo-host",
      route_model: "hf/fixture-org/route-metadata-model:promo-host",
      status: "live",
      is_free: true,
      free_catalog_eligible: true,
      supports_tools: true,
    },
  ]);
  assert.equal(model.provider_routes_provenance?.source, "huggingface.router_models_api");
  assert.equal(model.provider_routes_provenance?.pricing_unit, "USD / 1M tokens");
  assert.equal(model.provider_routes_provenance?.stale, false);

  const staleModel = body.data.find((entry) => entry.id === "hf/zai-org/GLM-stale");
  assert.ok(staleModel);
  assert.equal(staleModel.provider_routes_provenance?.stale, true);
  assert.equal(staleModel.provider_routes?.[0]?.is_free, true);
  assert.equal(staleModel.provider_routes?.[0]?.free_catalog_eligible, false);

  const freeToolRouteResponse = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request(
      "http://localhost/v1/models?free_only=true&require_tool_calling=true&configuredOnly=true"
    )
  );
  const freeToolRouteBody = (await freeToolRouteResponse.json()) as {
    data: Array<{
      id?: string;
      free?: boolean;
      context_length?: number;
      max_output_tokens?: number;
      capabilities?: Record<string, boolean>;
      capability_status?: { tool_calling?: { status?: string; source?: string } };
      route_selection?: { kind?: string; exactModelIdentity?: boolean };
      route_availability?: {
        accountEligibility?: string;
        downstreamHostSelection?: string;
      };
      provider_routes_provenance?: { stale?: boolean };
    }>;
  };
  const freeToolRoute = freeToolRouteBody.data.find(
    (entry) => entry.id === "hf/fixture-org/route-metadata-model:promo-host"
  );
  assert.ok(freeToolRoute, "current HF free host should be a selectable exact route");
  assert.equal(freeToolRoute.free, true);
  assert.equal(
    freeToolRoute.context_length,
    undefined,
    "a pinned host without its own context limit must not inherit the aggregate limit"
  );
  assert.equal(
    freeToolRoute.max_output_tokens,
    undefined,
    "a pinned host without an output limit must not inherit the aggregate limit"
  );
  assert.equal(freeToolRoute.capabilities?.tool_calling, true);
  assert.deepEqual(freeToolRoute.capability_status?.tool_calling, {
    status: "supported",
    source: "huggingface.router_models_api",
  });
  assert.deepEqual(freeToolRoute.route_selection, {
    kind: "exact_model",
    exactModelIdentity: true,
  });
  assert.equal(freeToolRoute.route_availability?.accountEligibility, "unknown");
  assert.equal(freeToolRoute.route_availability?.downstreamHostSelection, "pinned");
  assert.equal(freeToolRoute.provider_routes_provenance?.stale, false);
  assert.equal(
    freeToolRouteBody.data.some(
      (entry) => entry.id === "hf/fixture-org/route-metadata-model:together"
    ),
    false,
    "a paid host must not be included in a free-only catalog"
  );
  assert.equal(
    freeToolRouteBody.data.some((entry) => entry.id === "hf/zai-org/GLM-stale:promo-host"),
    false,
    "a stale provider-route catalog cannot authorize free-only use"
  );
});

test("Hugging Face model modalities survive discovery sync and reach the unified catalog", async () => {
  const connection = await seedConnection("huggingface");
  const discovered = normalizeOpenAiLikeModelsResponse(
    {
      data: [
        {
          id: "fixture-org/vision-route",
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
          },
        },
      ],
    },
    "huggingface"
  );

  await persistDiscoveredModels("huggingface", connection.id as string, discovered);
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/v1/models")
  );
  const body = (await response.json()) as {
    data: Array<{
      id: string;
      input_modalities?: string[];
      output_modalities?: string[];
      capabilities?: { vision?: boolean };
      capability_status?: { tool_calling?: { status?: string } };
    }>;
  };
  const model = body.data.find((entry) => entry.id === "hf/fixture-org/vision-route");

  assert.equal(response.status, 200);
  assert.ok(model);
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.deepEqual(model.output_modalities, ["text"]);
  assert.equal(model.capabilities?.vision, true);
  assert.equal(model.capability_status?.tool_calling?.status, "unknown");
  assert.equal(model.capabilities?.tool_calling, undefined);
});

test("v1 models catalog does not final-enrich combo names as real models", async () => {
  await combosDb.createCombo({
    name: "gpt-5.5",
    strategy: "priority",
    models: ["openai/no-known-metadata"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const combo = body.data.find((item) => item.id === "gpt-5.5");

  assert.equal(response.status, 200);
  assert.ok(combo);
  assert.equal(combo.owned_by, "combo");
  assert.equal("max_output_tokens" in combo, false);
  assert.equal("capabilities" in combo, false);
});

test("v1 models catalog exposes claude alias and provider-prefixed built-in models with vision metadata", async () => {
  await seedConnection("claude", {
    authType: "oauth",
    name: "claude-vision",
    apiKey: null,
    accessToken: "claude-access",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const aliasModel = body.data.find((item) => item.id === "cc/claude-sonnet-4-6");
  const providerModel = body.data.find((item) => item.id === "claude/claude-sonnet-4-6");

  assert.equal(response.status, 200);
  assert.ok(aliasModel);
  assert.ok(providerModel);
  assert.equal(providerModel.parent, aliasModel.id);
  assert.equal(aliasModel.capabilities?.vision, true);
  assert.deepEqual(aliasModel.input_modalities, ["text", "image"]);
  assert.deepEqual(aliasModel.output_modalities, ["text"]);
});

test("v1 models catalog exposes refreshed GitHub Copilot aliases and drops retired models", async () => {
  await seedConnection("github", {
    authType: "oauth",
    name: "github-current",
    apiKey: null,
    accessToken: "github-access",
    providerSpecificData: {
      copilotToken: "copilot-token",
    },
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const aliasModel = body.data.find((item) => item.id === "gh/gpt-5.4");
  const providerModel = body.data.find((item) => item.id === "github/gpt-5.4");
  const codexModel = body.data.find((item) => item.id === "gh/gpt-5.3-codex");
  const opusModel = body.data.find((item) => item.id === "github/claude-opus-4.7");

  assert.equal(response.status, 200);
  assert.ok(aliasModel);
  assert.ok(providerModel);
  assert.ok(codexModel);
  assert.ok(opusModel);
  assert.equal(providerModel.parent, aliasModel.id);
  assert.equal(
    body.data.some((item) => item.id === "gh/gpt-5.1"),
    false
  );
  assert.equal(
    body.data.some((item) => item.id === "gh/claude-opus-4.1"),
    false
  );
});

test("v1 models catalog exposes bare Codex-preferred IDs for native Codex clients", async () => {
  await seedConnection("codex", {
    authType: "oauth",
    name: "codex-native",
    apiKey: null,
    accessToken: "codex-access",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const getModel = (id: string) => body.data.find((item) => item.id === id);

  assert.equal(response.status, 200);
  const modelId = "codex-auto-review";
  const bareModel = getModel(modelId);
  const providerModel = getModel(`codex/${modelId}`);
  const aliasModel = getModel(`cx/${modelId}`);
  const openAiModel = getModel(`openai/${modelId}`);

  assert.ok(bareModel, `expected bare ${modelId} model`);
  assert.ok(providerModel, `expected codex/${modelId} model`);
  assert.ok(aliasModel, `expected cx/${modelId} model`);
  assert.equal(openAiModel, undefined);
  assert.equal(bareModel.owned_by, "codex");
  assert.equal(bareModel.parent, providerModel.id);
  assert.equal(providerModel.parent, aliasModel.id);
});

test("v1 models catalog exposes current Antigravity aliases without retired model IDs", async () => {
  await seedConnection("antigravity", {
    authType: "oauth",
    name: "antigravity-preview",
    apiKey: null,
    accessToken: "antigravity-access",
  });
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));
  assert.equal(response.status, 200);
  assert.equal(ids.has("antigravity/gemini-3-pro-preview"), false);
  assert.equal(ids.has("antigravity/gemini-3.1-pro"), false);
  assert.equal(ids.has("antigravity/gemini-2.5-computer-use-preview-10-2025"), false);
  assert.equal(ids.has("antigravity/rev19-uic3-1p"), false);
  assert.ok(ids.has("antigravity/gemini-3.7-flash-high"));
  assert.ok(ids.has("antigravity/gemini-3.7-flash-medium"));
  assert.ok(ids.has("antigravity/gemini-3.7-flash-low"));
  assert.equal(ids.has("antigravity/gemini-3.6-flash-high"), false);
  assert.equal(ids.has("antigravity/gemini-3.6-flash-medium"), false);
  assert.equal(ids.has("antigravity/gemini-3.6-flash-low"), false);
  assert.equal(ids.has("antigravity/gemini-3.5-flash"), false);
  assert.equal(ids.has("antigravity/gemini-3.5-flash-extra-low"), false);
  assert.equal(ids.has("antigravity/gemini-3.5-flash-low"), false);
  assert.equal(ids.has("antigravity/gemini-3-flash-agent"), false);
  assert.equal(ids.has("antigravity/gemini-3.5-flash-medium"), false);
  assert.equal(ids.has("antigravity/gemini-3.5-flash-high"), false);
  assert.equal(ids.has("antigravity/gemini-3.5-flash-preview"), false);
  assert.equal(ids.has("antigravity/gemini-3-flash-preview"), false);
  assert.equal(ids.has("antigravity/gemini-3.1-pro-high"), false);
  assert.ok(ids.has("antigravity/gemini-pro-agent"));
  assert.equal(ids.has("antigravity/gemini-claude-sonnet-4-5"), false);
  assert.equal(ids.has("antigravity/gemini-claude-sonnet-4-5-thinking"), false);
  assert.equal(ids.has("antigravity/gemini-claude-opus-4-5-thinking"), false);
});

test("v1 models catalog uses provider-node prefixes for compatible provider custom models", async () => {
  await providersDb.createProviderNode({
    id: "anthropic-compatible-demo",
    type: "anthropic-compatible",
    name: "Anthropic Demo",
    prefix: "cm",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/messages",
    modelsPath: "/v1/models",
  });
  await seedConnection("anthropic-compatible-demo", {
    name: "anthropic-node",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/messages",
      modelsPath: "/v1/models",
    },
  });
  await modelsDb.addCustomModel("anthropic-compatible-demo", "claude-edge", "Claude Edge");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.ok(ids.has("cm/claude-edge"));
  assert.equal(ids.has("anthropic-compatible-demo/claude-edge"), false);
});

test("v1 models catalog includes synced Gemini models and duplicates audio models for speech", async () => {
  const connection = await seedConnection("gemini", {
    name: "gemini-synced",
    apiKey: "gm-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "gemini" as any,
    (connection as any).id,
    [
      {
        id: "gemini-audio-live",
        name: "Gemini Audio Live",
        source: "imported",
        supportedEndpoints: ["audio"],
        inputTokenLimit: 4096,
      },
      {
        id: "text-embedding-004",
        name: "Text Embedding 004",
        source: "imported",
        supportedEndpoints: ["embeddings"],
        inputTokenLimit: 2048,
      },
      {
        id: "gemini-hidden",
        name: "Gemini Hidden",
        source: "imported",
        supportedEndpoints: ["chat"],
      },
    ]
  );
  modelsDb.mergeModelCompatOverride("gemini", "gemini-hidden", { isHidden: true });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const audioVariants = body.data.filter((item) => item.id === "gemini/gemini-audio-live");
  const embedding = body.data.find((item) => item.id === "gemini/text-embedding-004");

  assert.equal(response.status, 200);
  assert.equal(audioVariants.length, 2);
  assert.deepEqual(audioVariants.map((item) => item.subtype).sort(), ["speech", "transcription"]);
  assert.equal(embedding.type, "embedding");
  assert.equal(
    body.data.some((item) => item.id === "gemini/gemini-hidden"),
    false
  );
});

test("v1 models catalog keeps Gemini chat models untyped when synced endpoints are omitted", async () => {
  const connection = await seedConnection("gemini", {
    name: "gemini-chat-default",
    apiKey: "gm-chat-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection("gemini", (connection as any).id, [
    {
      id: "gemini-2.5-pro-live",
      name: "Gemini 2.5 Pro Live",
      source: "imported",
      inputTokenLimit: 8192,
    },
  ]);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const chatModel = body.data.find((item) => item.id === "gemini/gemini-2.5-pro-live");

  assert.equal(response.status, 200);
  assert.ok(chatModel);
  assert.equal("type" in chatModel, false);
  assert.equal("supported_endpoints" in chatModel, false);
  assert.equal(chatModel.context_length, 8192);
});

test("v1 models catalog includes synced non-Gemini provider models from discovery cache", async () => {
  const connection = await seedConnection("opencode-go", {
    name: "opencode-go-synced",
    apiKey: "go-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection("opencode-go", (connection as any).id, [
    {
      id: "glm-5.1",
      name: "GLM 5.1",
      source: "imported",
      supportedEndpoints: ["chat"],
      inputTokenLimit: 262144,
    },
  ]);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const syncedModel = body.data.find((item) => item.id === "opencode-go/glm-5.1");

  assert.equal(response.status, 200);
  assert.ok(syncedModel);
  assert.equal(syncedModel.owned_by, "opencode-go");
  assert.equal(syncedModel.context_length, 262144);
});

test("v1 models catalog retains registered effort aliases beside synced OpenCode Go bases", async () => {
  const connection = await seedConnection("opencode-go", {
    name: "opencode-go-effort-aliases",
    apiKey: "go-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection("opencode-go", connection.id, [
    {
      id: "hy3",
      name: "Hunyuan3",
      source: "imported",
      supportedEndpoints: ["chat"],
    },
  ]);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<{ id: string }> };
  const ids = body.data.map((item: { id: string }) => item.id);

  assert.equal(response.status, 200);
  assert.ok(ids.includes("opencode-go/hy3"));
  assert.ok(ids.includes("opencode-go/hy3-none"));
  assert.ok(ids.includes("opencode-go/hy3-low"));
  assert.ok(ids.includes("opencode-go/hy3-high"));
});

test("v1 models catalog advertises GLM-5.2 provider aliases with hosted context limits", async () => {
  const hfConnection = await seedConnection("huggingface", {
    name: "huggingface-glm52",
    apiKey: "hf-key",
  });
  const cfConnection = await seedConnection("cloudflare-ai", {
    name: "cloudflare-glm52",
    apiKey: "cf-key",
  });
  const zenmuxConnection = await seedConnection("zenmux", {
    name: "zenmux-glm52",
    apiKey: "zen-key",
  });
  await seedConnection("opencode-go", {
    name: "opencode-go-glm52",
    apiKey: "go-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "huggingface",
    (hfConnection as any).id,
    [
      {
        id: "zai-org/GLM-5.2",
        name: "GLM 5.2",
        source: "imported",
        supportedEndpoints: ["chat"],
        inputTokenLimit: 128000,
        outputTokenLimit: 128000,
      },
    ]
  );
  await modelsDb.replaceSyncedAvailableModelsForConnection(
    "cloudflare-ai",
    (cfConnection as any).id,
    [
      {
        id: "@cf/zai-org/glm-5.2",
        name: "GLM 5.2",
        source: "imported",
        supportedEndpoints: ["chat"],
        inputTokenLimit: 128000,
        outputTokenLimit: 128000,
      },
    ]
  );
  await modelsDb.replaceSyncedAvailableModelsForConnection("zenmux", (zenmuxConnection as any).id, [
    {
      id: "z-ai/glm-5.2",
      name: "GLM 5.2",
      source: "imported",
      supportedEndpoints: ["chat"],
      inputTokenLimit: 128000,
      outputTokenLimit: 128000,
    },
  ]);

  try {
    modelsDevSync.saveModelsDevCapabilities({
      huggingface: {
        "zai-org/GLM-5.2": capability({ limit_context: 128000, limit_input: 128000 }),
      },
      "cloudflare-ai": {
        "@cf/zai-org/glm-5.2": capability({ limit_context: 128000, limit_input: 128000 }),
      },
      zenmux: {
        "z-ai/glm-5.2": capability({ limit_context: 128000, limit_input: 128000 }),
      },
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const byId = new Map(body.data.map((item) => [item.id, item]));

    for (const [id, expectedContext] of [
      ["huggingface/zai-org/GLM-5.2", 128000],
      ["cloudflare-ai/@cf/zai-org/glm-5.2", 128000],
      ["opencode-go/glm-5.2", 1000000],
      ["zenmux/z-ai/glm-5.2", 128000],
    ] as const) {
      const model = byId.get(id) as any;
      assert.ok(model, `expected ${id} in catalog`);
      assert.equal(model.context_length, expectedContext, id);
      assert.equal(model.max_input_tokens, expectedContext, id);
    }
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog includes media, moderation, rerank, video, and music models for active providers", async () => {
  await seedConnection("openai", { name: "openai-media" });
  await seedConnection("cohere", { name: "cohere-rerank" });
  await seedConnection("comfyui", {
    name: "comfy-media",
    apiKey: null,
    accessToken: null,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const byId = new Map(body.data.map((item) => [item.id, item]));

  assert.equal(response.status, 200);
  assert.equal((byId.get("openai/gpt-image-2") as any).type, "image");
  assert.equal((byId.get("openai/whisper-1") as any).type, "audio");
  assert.equal((byId.get("openai/whisper-1") as any).subtype, "transcription");
  assert.equal((byId.get("openai/omni-moderation-latest") as any).type, "moderation");
  assert.equal((byId.get("cohere/rerank-v3.5") as any).type, "rerank");
  assert.equal((byId.get("comfyui/animatediff") as any).type, "video");
  assert.equal((byId.get("comfyui/stable-audio-open") as any).type, "music");
});

test("v1 models catalog does not duplicate imported Jina specialty models", async () => {
  const connection = await seedConnection("jina-ai", {
    name: "jina-synced",
    apiKey: "jina-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection("jina-ai", (connection as any).id, [
    {
      id: "jina-embeddings-v5-text-small",
      name: "Jina Embeddings v5 Text Small",
      source: "imported",
      apiFormat: "embeddings",
      supportedEndpoints: ["embeddings"],
    },
    {
      id: "jina-reranker-v3",
      name: "Jina Reranker v3",
      source: "imported",
      apiFormat: "rerank",
      supportedEndpoints: ["rerank"],
    },
  ]);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const visibleJinaEmbeddingRows = body.data.filter(
    (item) =>
      item.owned_by === "jina-ai" &&
      item.root === "jina-embeddings-v5-text-small" &&
      item.type === "embedding" &&
      !item.parent
  );
  const visibleJinaRerankRows = body.data.filter(
    (item) =>
      item.owned_by === "jina-ai" &&
      item.root === "jina-reranker-v3" &&
      item.type === "rerank" &&
      !item.parent
  );

  assert.equal(response.status, 200);
  assert.equal(visibleJinaEmbeddingRows.length, 1);
  assert.equal(visibleJinaEmbeddingRows[0].id, "jina/jina-embeddings-v5-text-small");
  assert.equal(visibleJinaRerankRows.length, 1);
  assert.equal(visibleJinaRerankRows[0].id, "jina/jina-reranker-v3");
});

test("v1 models catalog does not duplicate custom Jina specialty models", async () => {
  await seedConnection("jina-ai", {
    name: "jina-custom",
    apiKey: "jina-key",
  });
  await modelsDb.addCustomModel(
    "jina-ai",
    "jina-embeddings-v5-text-small",
    "Jina Embeddings v5 Text Small",
    "imported",
    "embeddings",
    ["embeddings"]
  );
  await modelsDb.addCustomModel(
    "jina-ai",
    "jina-reranker-v3",
    "Jina Reranker v3",
    "imported",
    "rerank",
    ["rerank"]
  );

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const visibleJinaEmbeddingRows = body.data.filter(
    (item) =>
      item.owned_by === "jina-ai" &&
      item.root === "jina-embeddings-v5-text-small" &&
      item.type === "embedding" &&
      !item.parent
  );
  const visibleJinaRerankRows = body.data.filter(
    (item) =>
      item.owned_by === "jina-ai" &&
      item.root === "jina-reranker-v3" &&
      item.type === "rerank" &&
      !item.parent
  );

  assert.equal(response.status, 200);
  assert.equal(visibleJinaEmbeddingRows.length, 1);
  assert.equal(visibleJinaEmbeddingRows[0].id, "jina-ai/jina-embeddings-v5-text-small");
  assert.equal(visibleJinaRerankRows.length, 1);
  assert.equal(visibleJinaRerankRows[0].id, "jina-ai/jina-reranker-v3");
});

test("v1 models catalog exposes image model input and output modalities for advanced image providers", async () => {
  await seedConnection("together", { name: "together-images" });
  await seedConnection("topaz", { name: "topaz-images" });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const byId = new Map(body.data.map((item) => [item.id, item]));

  assert.equal(response.status, 200);
  assert.deepEqual((byId as any).get("flux-2-dev")?.input_modalities, ["text", "image"]);
  (assert as any).deepEqual((byId.get("flux-2-dev") as any).output_modalities, ["image"]);
  (assert as any).equal((byId.get("flux-2-dev") as any).type, "image");
  assert.ok((byId.get("flux-2-dev") as any).supported_sizes?.includes("1024x1024"));
  (assert as any).deepEqual((byId.get("topaz/topaz-enhance") as any).input_modalities, ["image"]);
  assert.deepEqual((byId.get("topaz/topaz-enhance") as any).output_modalities, ["image"]);
});

test("v1 models catalog tolerates custom model lookup failures and keeps builtin models available", async () => {
  await seedConnection("openai", { name: "openai-custom-failure" });

  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const originalLog = console.log;
  const logs = [];

  db.prepare = (sql) => {
    if (String(sql) === "SELECT key, value FROM key_value WHERE namespace = 'customModels'") {
      throw new Error("custom models offline");
    }
    return originalPrepare(sql);
  };
  console.log = (...args) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.ok(body.data.some((item) => item.id === "openai/gpt-4o-2024-11-20"));
    assert.ok(logs.some((entry) => entry.includes("Could not fetch custom models")));
  } finally {
    db.prepare = originalPrepare;
    console.log = originalLog;
  }
});

test("v1 models catalog exposes provider-prefixed custom models, filters by raw model permissions, and skips hidden or Gemini custom rows", async () => {
  await seedConnection("cline", {
    authType: "oauth",
    name: "cline-custom",
    apiKey: null,
    accessToken: "cline-access",
  });
  await seedConnection("gemini", { name: "gemini-custom" });

  await modelsDb.addCustomModel("cline", "demo-custom", "Demo Custom", "manual", "responses", [
    "images",
  ]);
  await modelsDb.updateCustomModel("cline", "demo-custom", {
    inputTokenLimit: 1234,
  });
  await modelsDb.addCustomModel("gemini", "gemini-custom-only", "Gemini Custom");

  const db = core.getDbInstance();
  db.prepare("UPDATE key_value SET value = ? WHERE namespace = 'customModels' AND key = ?").run(
    JSON.stringify([
      {
        id: "demo-custom",
        name: "Demo Custom",
        apiFormat: "responses",
        supportedEndpoints: ["images"],
        inputTokenLimit: 1234,
      },
      {
        id: "hidden-custom",
        name: "Hidden Custom",
        isHidden: true,
      },
      {
        name: "Missing Id",
      },
      null,
    ]),
    "cline"
  );

  const key = await apiKeysDb.createApiKey("catalog-root-filter", "machine-root-filter");
  await apiKeysDb.updateApiKeyPermissions(key.id, {
    allowedModels: ["demo-custom"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models", {
      headers: { Authorization: `Bearer ${key.key}` },
    })
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));
  const shortAlias = body.data.find((item) => item.id === "cl/demo-custom");
  const providerAlias = body.data.find((item) => item.id === "cline/demo-custom");

  assert.equal(response.status, 200);
  assert.ok(ids.has("cl/demo-custom"));
  assert.ok(ids.has("cline/demo-custom"));
  assert.equal(ids.has("cl/hidden-custom"), false);
  assert.equal(ids.has("gemini/gemini-custom-only"), false);
  assert.equal(shortAlias.type, "image");
  assert.equal(shortAlias.api_format, "responses");
  assert.deepEqual(shortAlias.supported_endpoints, ["images"]);
  assert.equal(shortAlias.context_length, 1234);
  assert.equal(providerAlias.parent, "cl/demo-custom");
});

test("v1 models catalog uses synced models.dev limits instead of provider defaults", async () => {
  await seedConnection("openai", { name: "openai-models-dev" });

  try {
    modelsDevSync.saveModelsDevCapabilities({
      openai: {
        "gpt-5.5": {
          tool_call: true,
          reasoning: true,
          attachment: true,
          structured_output: true,
          temperature: true,
          modalities_input: JSON.stringify(["text", "image"]),
          modalities_output: JSON.stringify(["text"]),
          knowledge_cutoff: null,
          release_date: null,
          last_updated: null,
          status: null,
          family: "gpt-5",
          open_weights: false,
          limit_context: 1050000,
          limit_input: 1050000,
          limit_output: 128000,
          interleaved_field: null,
        },
      },
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const model = body.data.find((item) => item.id === "openai/gpt-5.5");

    assert.equal(response.status, 200);
    assert.ok(model);
    assert.equal(model.context_length, 1050000);
    assert.equal(model.max_input_tokens, 1050000);
    assert.equal(model.max_output_tokens, 128000);
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog preserves synchronized pricing provenance in serialized rows", async () => {
  await seedConnection("openai", { name: "openai-pricing-provenance" });

  try {
    modelsDevSync.saveModelsDevPricing({
      openai: {
        "gpt-4o": { input: 2.5, output: 10 },
      },
    });
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        pricing?: { input?: number; output?: number };
        pricing_provenance?: {
          state: string;
          source: { id: string; retrievedAt: string | null; stale: boolean | null };
        };
      }>;
    };
    const model = body.data.find((item) => item.id === "openai/gpt-4o");

    assert.equal(response.status, 200);
    assert.ok(model);
    assert.equal(model.pricing.input, 2.5);
    assert.equal(model.pricing.output, 10);
    assert.equal(model.pricing_provenance.state, "third_party_reported_pricing");
    assert.equal(model.pricing_provenance.source.id, "models_dev.api_json");
    assert.equal(model.pricing_provenance.source.retrievedAt, null);
    assert.equal(model.pricing_provenance.source.stale, null);
  } finally {
    modelsDevSync.clearModelsDevPricing();
  }
});

test("v1 models catalog applies exact Amazon Bedrock metadata without pricing alias variants", async () => {
  await seedConnection("bedrock", { name: "bedrock-models-dev-provenance" });

  const raw = {
    "amazon-bedrock": {
      id: "amazon-bedrock",
      models: {
        "anthropic.claude-opus-4-7": {
          id: "anthropic.claude-opus-4-7",
          name: "Claude Opus 4.7",
          cost: { input: 4, output: 20 },
          tool_call: true,
          limit: { context: 750_000, output: 100_000 },
        },
        "anthropic.claude-sonnet-4-5-20250929-v1:0": {
          id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
          name: "Claude Sonnet 4.5 versioned Bedrock route",
          cost: { input: 3.3, output: 16.5 },
          tool_call: true,
          limit: { context: 200_000, output: 64_000 },
        },
      },
    },
  };

  try {
    modelsDevSync.saveModelsDevPricing(modelsDevSync.transformModelsDevToPricing(raw as never));
    modelsDevSync.saveModelsDevCapabilities(
      modelsDevSync.transformModelsDevToCapabilities(raw as never)
    );

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as {
      data: Array<{
        id: string;
        pricing?: { input?: number; output?: number };
        pricing_provenance?: { state?: string; source?: { id?: string } };
        capability_status?: { tool_calling?: { status?: string; source?: string } };
        context_length?: number;
        max_output_tokens?: number;
      }>;
    };
    const exactRoute = body.data.find((model) => model.id === "bedrock/anthropic.claude-opus-4-7");
    const shortenedAlias = body.data.find(
      (model) => model.id === "bedrock/anthropic.claude-sonnet-4-5"
    );

    assert.equal(response.status, 200);
    assert.ok(exactRoute);
    assert.deepEqual(exactRoute.pricing, { input: 4, output: 20 });
    assert.equal(exactRoute.pricing_provenance?.state, "third_party_reported_pricing");
    assert.equal(exactRoute.pricing_provenance?.source?.id, "models_dev.api_json");
    assert.deepEqual(exactRoute.capability_status?.tool_calling, {
      status: "supported",
      source: "synced_capability_catalog",
    });
    assert.equal(exactRoute.context_length, 750_000);
    assert.equal(exactRoute.max_output_tokens, 100_000);

    assert.ok(shortenedAlias);
    assert.equal(shortenedAlias.pricing, undefined);
    assert.equal(shortenedAlias.pricing_provenance?.state, "unavailable");
  } finally {
    modelsDevSync.saveModelsDevPricing({});
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog exposes Bedrock Claude token limits from static metadata", async () => {
  await seedConnection("bedrock", { name: "bedrock-limits" });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const sonnet46 = body.data.find((item) => item.id === "bedrock/anthropic.claude-sonnet-4-6");
  const sonnet45 = body.data.find((item) => item.id === "bedrock/anthropic.claude-sonnet-4-5");
  const opus46 = body.data.find((item) => item.id === "bedrock/anthropic.claude-opus-4-6");

  assert.equal(response.status, 200);
  assert.ok(sonnet46);
  assert.equal(sonnet46.context_length, 1000000);
  assert.equal(sonnet46.max_input_tokens, 1000000);
  assert.equal(sonnet46.max_output_tokens, 64000);
  assert.ok(sonnet45);
  assert.equal(sonnet45.context_length, 200000);
  assert.equal(sonnet45.max_output_tokens, 64000);
  assert.ok(opus46);
  assert.equal(opus46.context_length, 1000000);
  assert.equal(opus46.max_output_tokens, 128000);
});

test("v1 models catalog lets provider-specific synced limits beat global static specs", async () => {
  await seedConnection("github", {
    authType: "oauth",
    name: "github-copilot-models-dev",
    apiKey: null,
    accessToken: "github-access",
  });

  try {
    modelsDevSync.saveModelsDevCapabilities({
      github: {
        "gpt-5.5": {
          tool_call: true,
          reasoning: true,
          attachment: true,
          structured_output: true,
          temperature: true,
          modalities_input: JSON.stringify(["text", "image"]),
          modalities_output: JSON.stringify(["text"]),
          knowledge_cutoff: null,
          release_date: null,
          last_updated: null,
          status: null,
          family: "gpt-5",
          open_weights: false,
          limit_context: 400000,
          limit_input: 272000,
          limit_output: 128000,
          interleaved_field: null,
        },
      },
    });

    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;
    const model = body.data.find((item) => item.id === "gh/gpt-5.5");

    assert.equal(response.status, 200);
    assert.ok(model);
    assert.equal(model.context_length, 400000);
    assert.equal(model.max_input_tokens, 272000);
    assert.equal(model.max_output_tokens, 128000);
  } finally {
    modelsDevSync.saveModelsDevCapabilities({});
  }
});

test("v1 models catalog returns 500 when model compatibility lookup crashes", async () => {
  await seedConnection("openai", { name: "openai-compat-crash" });

  const db = core.getDbInstance();
  const originalPrepare = db.prepare.bind(db);
  const originalLog = console.log;
  const logs = [];

  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    // #9147: the catalog builder now resolves hidden models via a single bulk
    // read (`getHiddenModelsByProvider()`, src/lib/db/models.ts) instead of the
    // old per-provider `SELECT value FROM key_value WHERE namespace = ? AND
    // key = ?` / readCompatList() lookup — intercept the bulk query's `.all()`
    // call so this test still exercises "DB read for model visibility crashes
    // -> catalog endpoint surfaces 500" against the current implementation.
    if (
      String(sql) !==
      "SELECT namespace, key, value FROM key_value WHERE namespace IN ('modelCompatOverrides', 'customModels')"
    ) {
      return statement;
    }

    return new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === "all") {
          return (...args) => {
            throw new Error("compat lookup boom");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  console.log = (...args) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    const response = await v1ModelsCatalog.getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 500);
    assert.equal(body.error.type, "server_error");
    assert.match(body.error.message, /compat lookup boom/i);
    assert.ok(logs.some((entry) => entry.includes("Error fetching models:")));
  } finally {
    db.prepare = originalPrepare;
    console.log = originalLog;
  }
});

test("v1 models catalog skips duplicate built-ins and custom models from inactive providers", async () => {
  await seedConnection("openai", { name: "openai-duplicate" });
  await seedConnection("cline", {
    authType: "oauth",
    name: "cline-inactive-custom",
    apiKey: null,
    accessToken: "cline-access",
    isActive: false,
  });

  await modelsDb.addCustomModel("openai", "gpt-4o-2024-11-20", "Duplicate Builtin");
  await modelsDb.addCustomModel("cline", "inactive-only", "Inactive Only");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const duplicateBuiltins = body.data.filter((item) => item.id === "openai/gpt-4o-2024-11-20");

  assert.equal(response.status, 200);
  // Still exactly one entry: the custom row overlays the built-in, it does not duplicate it.
  assert.equal(duplicateBuiltins.length, 1);
  // #10248 changed the contract: a custom row for an id that already exists is the
  // operator-owned overlay for that model (catalog.ts:1330) — its explicitly stored
  // fields win over the discovered metadata, and the merged entry is flagged `custom`.
  // Before #10248 the duplicate was skipped outright, so this asserted `false`.
  assert.equal(duplicateBuiltins[0].custom, true);
  // The overlay must keep the catalog identity rather than becoming a detached entry.
  assert.equal(duplicateBuiltins[0].id, "openai/gpt-4o-2024-11-20");
  assert.equal(
    body.data.some((item) => item.id === "cl/inactive-only" || item.id === "cline/inactive-only"),
    false
  );
});

test("v1 models catalog adds managed fallback models for Claude-compatible providers", async () => {
  await providersDb.createProviderNode({
    id: "anthropic-compatible-cc-demo",
    type: "anthropic-compatible",
    name: "Claude Compatible Demo",
    prefix: "ccdemo",
    baseUrl: "https://proxy.example.com",
    chatPath: "/v1/messages",
    modelsPath: "/v1/models",
  });
  await seedConnection("anthropic-compatible-cc-demo", {
    name: "claude-compatible-node",
    providerSpecificData: {
      baseUrl: "https://proxy.example.com",
      chatPath: "/v1/messages",
      modelsPath: "/v1/models",
    },
  });
  modelsDb.mergeModelCompatOverride("anthropic-compatible-cc-demo", "claude-sonnet-4-6", {
    isHidden: true,
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids = new Set(body.data.map((item) => item.id));

  assert.equal(response.status, 200);
  assert.ok(ids.has("ccdemo/claude-opus-4-7"));
  assert.ok(ids.has("ccdemo/claude-opus-4-6"));
  assert.equal(ids.has("ccdemo/claude-sonnet-4-6"), false);
});

test("v1 models catalog auto-calculates combo context_length from targets when not set manually", async () => {
  await seedConnection("openai", { name: "openai-auto-context" });
  await seedConnection("claude", {
    authType: "oauth",
    name: "claude-auto-context",
    apiKey: null,
    accessToken: "claude-access",
  });

  // Create a combo with targets having different context limits.
  // openai/gpt-4o context = 128000, claude/claude-sonnet-4-6 = 1000000 (#7129: 1M GA).
  // The combo should expose context_length = min = 128000.
  const combo = await combosDb.createCombo({
    name: "auto-context-combo",
    strategy: "priority",
    models: ["openai/gpt-4o", "claude/claude-sonnet-4-6"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const comboModel = body.data.find((item) => item.id === "auto-context-combo");

  assert.equal(response.status, 200);
  assert.ok(comboModel);
  assert.equal(
    comboModel.context_length,
    128000,
    "combo context_length should be the MIN of all target model limits"
  );
});

test("v1 models catalog includes context_length for individual chat models", async () => {
  await seedConnection("openai", { name: "openai-context" });
  await seedConnection("claude", {
    authType: "oauth",
    name: "claude-context",
    apiKey: null,
    accessToken: "claude-access",
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  // Individual chat models only — combos/routers (owned_by "combo", incl. the
  // built-in auto/* entries from #4164) resolve dynamically and have no fixed
  // context_length, so they are not "individual chat models" for this check.
  const chatModels = body.data.filter(
    (item) => (!item.type || item.type === "chat") && item.owned_by !== "combo"
  );

  assert.equal(response.status, 200);
  assert.ok(chatModels.length > 0, "should have at least one chat model");

  for (const model of chatModels) {
    assert.ok(
      typeof model.context_length === "number" && model.context_length > 0,
      `chat model ${model.id} should have a positive context_length, got ${model.context_length}`
    );
  }
});

test("v1 models catalog falls back to getTokenLimit for models without registry defaultContextLength", async () => {
  // opencode-go has defaultContextLength in REGISTRY, but we test the fallback
  // path by verifying models from the synced path still get context_length
  const connection = await seedConnection("opencode-go", {
    name: "opencode-go-context-fallback",
    apiKey: "go-key",
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection("opencode-go", (connection as any).id, [
    {
      id: "test-model-no-context",
      name: "Test Model No Context",
      source: "imported",
      supportedEndpoints: ["chat"],
    },
  ]);

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const model = body.data.find((item) => item.id === "opencode-go/test-model-no-context");

  assert.equal(response.status, 200);
  assert.ok(model, "synced model should appear");
  assert.ok(
    typeof model.context_length === "number" && model.context_length > 0,
    `synced model without inputTokenLimit should get context_length via getTokenLimit fallback, got ${model.context_length}`
  );
});

test("v1 models catalog prefers manual combo context_length over auto-calculated", async () => {
  await seedConnection("openai", { name: "openai-manual-context" });

  const combo = await combosDb.createCombo({
    name: "manual-context-combo",
    strategy: "priority",
    models: ["openai/gpt-4o"],
  });
  await combosDb.updateCombo((combo as any).id, { context_length: 64000 });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const comboModel = body.data.find((item) => item.id === "manual-context-combo");

  assert.equal(response.status, 200);
  assert.ok(comboModel);
  assert.equal(comboModel.context_length, 64000, "manual context_length should override auto-calc");
});

test("v1 models catalog computes combo context_length from known targets when some targets have unknown context", async () => {
  await seedConnection("openai", { name: "openai-mixed-context" });
  await seedConnection("claude", {
    authType: "oauth",
    name: "claude-mixed-context",
    apiKey: null,
    accessToken: "claude-access",
  });

  // Create a combo with targets: one known (gpt-4o = 128K), one unknown (nonexistent-model).
  // The combo should still compute context_length = 128K from the known target.
  const combo = await combosDb.createCombo({
    name: "mixed-context-combo",
    strategy: "priority",
    models: ["openai/gpt-4o", "openai/nonexistent-model-xyz"],
  });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const comboModel = body.data.find((item) => item.id === "mixed-context-combo");

  assert.equal(response.status, 200);
  assert.ok(comboModel);
  assert.equal(
    comboModel.context_length,
    128000,
    "combo context_length should be the MIN of known target model limits, ignoring targets with no registry/spec/synced source"
  );
});

// Regression test for Issue #2798: noAuth providers (opencode/oc) have no DB connection rows
// but their models must still appear in /v1/models.
test("v1 models catalog includes noAuth provider models when no DB connections exist (#2798)", async () => {
  // No connections seeded — empty DB, simulating a fresh install with no credentials added.
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids: string[] = body.data.map((item: any) => item.id);

  assert.equal(response.status, 200);
  // opencode (noAuth) models must surface even with zero connection rows.
  // The registry defines models under alias "oc" (e.g. "oc/big-pickle").
  assert.ok(
    ids.some((id) => id.startsWith("oc/")),
    `Expected at least one oc/* model in /v1/models but got none. IDs sample: ${ids.slice(0, 10).join(", ")}`
  );
  assert.equal(
    ids.some((id) => id.startsWith("opencode/")),
    false,
    "catalog must not return opencode/* noAuth aliases because opencode/ routes to opencode-zen"
  );
});

test("configuredOnly does not treat an unrelated connection as backing a noAuth route", async () => {
  await seedConnection("openai");

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models?configuredOnly=true")
  );
  const body = (await response.json()) as { data: Array<{ id?: string }> };

  assert.equal(response.status, 200);
  assert.equal(
    body.data.some((model) => model.id?.startsWith("oc/")),
    false,
    "an OpenAI credential cannot make an OpenCode noAuth model configured"
  );
});

test("v1 models catalog hides disabled noAuth provider models", async () => {
  await settingsDb.updateSettings({ blockedProviders: ["opencode", "duckduckgo-web"] });

  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as any;
  const ids: string[] = body.data.map((item: any) => item.id);

  assert.equal(response.status, 200);
  assert.equal(
    ids.some((id) => id.startsWith("oc/")),
    false,
    "OpenCode no-auth models must be hidden while no-auth providers are disabled"
  );
  assert.equal(
    ids.some((id) => id.startsWith("ddgw/")),
    false,
    "DuckDuckGo no-auth models must be hidden while no-auth providers are disabled"
  );
});
