import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-model-catalog-sources-8728-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const models = await import("../../src/lib/db/models.ts");
const aliases = await import("../../src/lib/db/models/aliases.ts");
const compat = await import("../../src/lib/db/models/compat.ts");
const ccAliases = await import("../../src/lib/db/ccDiscoveryAliases.ts");
const featureFlags = await import("../../src/lib/db/featureFlags.ts");
const readCache = await import("../../src/lib/db/readCache.ts");
const openRouterCatalog = await import("../../src/lib/catalog/openrouterCatalog.ts");
const openRouterFreeModels = await import("../../src/lib/catalog/openrouterFreeModels.ts");

function resetStorage() {
  core.resetDbInstance();
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function catalogVersion() {
  return readCache.getModelCatalogCacheVersion();
}

const REAL_FETCH = globalThis.fetch;

function installMockOpenRouterFetch(payload: { data: Array<Record<string, unknown>> }): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function installFailingOpenRouterFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error("simulated openrouter failure");
  }) as typeof fetch;
}

function restoreRealFetch(): void {
  globalThis.fetch = REAL_FETCH;
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  restoreRealFetch();
});

test("custom-model source writes invalidate model-catalog cache version; no-op writes do not", async () => {
  let version = catalogVersion();

  await models.addCustomModel("openai", "manual-one");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  const duplicate = await models.addCustomModel("openai", "manual-one");
  assert.equal(duplicate.id, "manual-one");
  assert.equal(catalogVersion(), version);

  await models.replaceCustomModels("openai", [
    { id: "manual-one", source: "manual", apiFormat: "chat-completions" },
    { id: "imported-one", source: "auto-sync", apiFormat: "chat-completions" },
  ]);
  version = version + 1;
  assert.equal(catalogVersion(), version);

  const removedIds = await models.deleteImportedCustomModels("openai");
  assert.deepEqual(removedIds, ["imported-one"]);
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  const removedExisting = await models.removeCustomModel("openai", "manual-one");
  assert.equal(removedExisting, true);
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  const removedMissing = await models.removeCustomModel("openai", "missing");
  assert.equal(removedMissing, false);
  assert.equal(catalogVersion(), version);

  const updatedMissing = await models.updateCustomModel("openai", "missing", {
    modelName: "Missing",
  });
  assert.equal(updatedMissing, null);
  assert.equal(catalogVersion(), version);

  const noImported = await models.deleteImportedCustomModels("openai");
  assert.deepEqual(noImported, []);
  assert.equal(catalogVersion(), version);

  await models.addCustomModel("openai", "manual-two", "manual two");
  version = catalogVersion();
  const updateResult = await models.updateCustomModel("openai", "manual-two", {
    modelName: "Manual Two",
  });
  assert.notEqual(updateResult, null);
  assert.equal(catalogVersion(), version + 1);

  const noTarget = await models.updateCustomModel("openai", "missing", { modelName: "Missing" });
  assert.equal(noTarget, null);
  assert.equal(catalogVersion(), version + 1);
});

test("model alias and compat writes invalidate model-catalog cache version", async () => {
  let version = catalogVersion();

  await aliases.setModelAlias("alias-alpha", "openai/manual-one");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  await aliases.deleteModelAlias("alias-alpha");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  compat.writeCompatList("openai", [
    {
      id: "manual-two",
      normalizeToolCallId: true,
    },
  ]);
  assert.equal(catalogVersion(), version + 1);
});

test("Claude Code discovery alias setters invalidate on both write and inherit/delete", () => {
  let version = catalogVersion();

  ccAliases.setCcAliasProviderSetting("openai", "on");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  ccAliases.setCcAliasProviderSetting("openai", null);
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  ccAliases.setCcAliasModelSetting("openai", "gpt-4", "on");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  ccAliases.setCcAliasModelSetting("openai", "gpt-4", null);
  assert.equal(catalogVersion(), version + 1);
});

test("feature flag writes invalidate catalog version only for catalog-relevant overrides", async () => {
  const unrelatedBefore = catalogVersion();
  featureFlags.setFeatureFlagOverride("ARENA_ELO_SYNC_ENABLED", "true");
  assert.equal(catalogVersion(), unrelatedBefore);

  let version = catalogVersion();
  featureFlags.setFeatureFlagOverride("MODEL_CATALOG_INCLUDE_NAMES", "false");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  featureFlags.setFeatureFlagOverride("MODELS_CATALOG_PREFIX_MODE", "alias");
  assert.equal(catalogVersion(), version + 1);

  version = catalogVersion();
  featureFlags.setFeatureFlagOverride("EXPOSE_CC_DISCOVERY_ALIASES", "true");
  assert.equal(catalogVersion(), version + 1);

  const relevantKeyBeforeRemove = catalogVersion();
  featureFlags.removeFeatureFlagOverride("MODEL_CATALOG_INCLUDE_NAMES");
  assert.equal(catalogVersion(), relevantKeyBeforeRemove + 1);

  featureFlags.setFeatureFlagOverride("MODELS_CATALOG_PREFIX_MODE", "dual");
  const irrelevantClearVersion = catalogVersion();
  featureFlags.setFeatureFlagOverride("ARENA_ELO_SYNC_ENABLED", "true");
  featureFlags.clearAllFeatureFlagOverrides();
  assert.equal(catalogVersion(), irrelevantClearVersion + 1);

  const clearNoRelevantBefore = catalogVersion();
  featureFlags.clearAllFeatureFlagOverrides();
  assert.equal(catalogVersion(), clearNoRelevantBefore);
});

test("refreshOpenRouterCatalog invalidates only on success", async () => {
  installMockOpenRouterFetch({ data: [{ id: "openrouter/fake", source: "test" }] });
  try {
    const beforeGet = catalogVersion();
    const catalog = await openRouterCatalog.getOpenRouterCatalog();
    assert.equal(catalog.stale, false);
    assert.equal(typeof catalog.cachedAt, "string");
    assert.ok(Number.isFinite(Date.parse(catalog.cachedAt ?? "")));
    assert.ok(catalog.cacheTtlMs > 0);
    assert.equal(
      catalogVersion(),
      beforeGet,
      "ordinary get should not invalidate the model-catalog cache"
    );

    const beforeRefreshSuccess = catalogVersion();
    const success = await openRouterCatalog.refreshOpenRouterCatalog();
    assert.equal(success.ok, true);
    assert.equal(catalogVersion(), beforeRefreshSuccess + 1);

    installFailingOpenRouterFetch();
    const beforeRefreshFailure = catalogVersion();
    const failed = await openRouterCatalog.refreshOpenRouterCatalog();
    assert.equal(failed.ok, false);
    assert.equal(catalogVersion(), beforeRefreshFailure, "failed refresh should not invalidate");
  } finally {
    restoreRealFetch();
  }
});

test("OpenRouter free route eligibility follows each successful catalog refresh", async () => {
  const snapshots = [
    { data: [{ id: "provider/new-free:free", supported_parameters: ["tools"] }] },
    {
      data: [
        { id: "provider/replacement:free", supported_parameters: ["tools"] },
        { id: "provider/no-tools:free", supported_parameters: [] },
        {
          id: "provider/explicit-zero",
          pricing: { prompt: "0", completion: "0", image: "0", request: "0" },
        },
      ],
    },
  ];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(snapshots.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const firstRefresh = await openRouterCatalog.refreshOpenRouterCatalog();
  assert.equal(firstRefresh.ok, true);
  const firstCatalog = await openRouterCatalog.getOpenRouterCatalog();
  assert.deepEqual(
    [...(await openRouterCatalog.getCurrentOpenRouterFreeRouteIds())!],
    ["provider/new-free:free"],
    "routing eligibility exposes the exact fresh free route"
  );
  assert.deepEqual(
    openRouterFreeModels
      .discoverOpenRouterFreeModels(
        firstCatalog.data,
        firstCatalog.cachedAt ?? "",
        firstCatalog.stale
      )
      .map((model) => model.modelId),
    ["provider/new-free:free"]
  );

  const secondRefresh = await openRouterCatalog.refreshOpenRouterCatalog();
  assert.equal(secondRefresh.ok, true);
  const secondCatalog = await openRouterCatalog.getOpenRouterCatalog();
  assert.deepEqual(
    [...(await openRouterCatalog.getCurrentOpenRouterFreeRouteIds())!],
    ["provider/replacement:free", "provider/no-tools:free", "provider/explicit-zero"],
    "rotation removes the old route and preserves a distinct exact route with authoritative zero rates"
  );
  assert.deepEqual(
    [...(await openRouterCatalog.getCurrentOpenRouterFreeRouteIds({ requireTools: true }))!],
    ["provider/replacement:free"],
    "tool-required routing keeps only current free routes whose catalog metadata supports tools"
  );
  assert.deepEqual(
    openRouterFreeModels
      .discoverOpenRouterFreeModels(
        secondCatalog.data,
        secondCatalog.cachedAt ?? "",
        secondCatalog.stale
      )
      .map((model) => model.modelId),
    ["provider/explicit-zero", "provider/no-tools:free", "provider/replacement:free"]
  );
});

test("OpenRouter catalog refreshes free routes within the bounded TTL and throttles outage retries", async () => {
  installMockOpenRouterFetch({ data: [{ id: "provider/old:free" }] });
  const primed = await openRouterCatalog.refreshOpenRouterCatalog();
  assert.equal(primed.ok, true);

  const cachePath = path.join(TEST_DATA_DIR, "cache", "openrouter-catalog.json");
  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
    data: Array<Record<string, unknown>>;
  };
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: "2000-01-01T00:00:00.000Z", data: cached.data })
  );
  process.env.OPENROUTER_CATALOG_TTL_MS = "900000";

  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new Error("simulated outage");
  }) as typeof fetch;
  try {
    const staleFirstRead = await openRouterCatalog.getOpenRouterCatalog();
    const staleSecondRead = await openRouterCatalog.getOpenRouterCatalog();
    assert.equal(staleFirstRead.stale, true);
    assert.equal(staleFirstRead.cacheTtlMs, 900_000);
    assert.equal(staleSecondRead.stale, true);
    assert.equal(
      await openRouterCatalog.getCurrentOpenRouterFreeRouteIds(),
      null,
      "stale display metadata cannot authorize a current free route"
    );
    assert.equal(attempts, 1, "failed catalog fetch is throttled for the retry window");
  } finally {
    delete process.env.OPENROUTER_CATALOG_TTL_MS;
    restoreRealFetch();
  }
});
