import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-free-route-admission-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_CATALOG_TTL_MS = "60000";

const { checkFreeRouteAdmission, checkToolCallingRouteAdmission } =
  await import("../../open-sse/handlers/chatCore/freeRouteAdmission.ts");
const { getCurrentOpenRouterFreeRouteIds } =
  await import("../../src/lib/catalog/openrouterCatalog.ts");
const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.ts");
const coreDb = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const modelsDevSync = await import("../../src/lib/modelsDevSync.ts");
const realFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("free admission is exact to the current OpenRouter route variant", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "openrouter/free", pricing: { prompt: "0", completion: "0" } },
          { id: "acme/model-a:free" },
          { id: "acme/tool-model:free", supported_parameters: ["tools"] },
          { id: "acme/non-tool-model:free", supported_parameters: ["temperature"] },
          { id: "acme/model-a", pricing: { prompt: "0.000001", completion: "0.000002" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const currentFreeRoute = await checkFreeRouteAdmission("openrouter", "acme/model-a:free");
  const paidSibling = await checkFreeRouteAdmission("openrouter", "acme/model-a");
  const dynamicRouter = await checkFreeRouteAdmission("openrouter", "free");
  const exactFreeRouteIds = await getCurrentOpenRouterFreeRouteIds();
  const toolCapable = await checkToolCallingRouteAdmission("openrouter", "acme/tool-model:free");
  const nonToolCapable = await checkToolCallingRouteAdmission(
    "openrouter",
    "acme/non-tool-model:free"
  );
  const dynamicToolCapability = await checkToolCallingRouteAdmission("openrouter", "free");

  assert.deepEqual(currentFreeRoute, { kind: "eligible", source: "openrouter.models_api" });
  assert.deepEqual(paidSibling, { kind: "ineligible", reason: "not_free" });
  assert.deepEqual(dynamicRouter, { kind: "eligible", source: "openrouter.models_api" });
  assert.equal(exactFreeRouteIds?.has("openrouter/free"), false);
  assert.deepEqual(toolCapable, { kind: "eligible", source: "openrouter.models_api" });
  assert.deepEqual(nonToolCapable, { kind: "ineligible", reason: "unsupported" });
  assert.deepEqual(dynamicToolCapability, { kind: "ineligible", reason: "unknown" });
});

test("the dynamic router does not prove that the free rotation has any exact routes", async () => {
  const cachePath = path.join(dataDir, "cache", "openrouter-catalog.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      data: [{ id: "openrouter/free", pricing: { prompt: "0", completion: "0" } }],
    })
  );

  const dynamicRouter = await checkFreeRouteAdmission("openrouter", "free");
  assert.deepEqual(dynamicRouter, { kind: "ineligible", reason: "not_free" });
});

test("free admission rejects stale OpenRouter membership after a failed refresh", async () => {
  const cachePath = path.join(dataDir, "cache", "openrouter-catalog.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: new Date(Date.now() - 120_000).toISOString(),
      data: [{ id: "acme/model-a:free" }],
    })
  );
  globalThis.fetch = (async () => {
    throw new Error("simulated catalog outage");
  }) as typeof fetch;

  const staleRoute = await checkFreeRouteAdmission("openrouter", "acme/model-a:free");
  const staleToolCapability = await checkToolCallingRouteAdmission(
    "openrouter",
    "acme/model-a:free"
  );

  assert.deepEqual(staleRoute, { kind: "ineligible", reason: "catalog_unverified" });
  assert.deepEqual(staleToolCapability, { kind: "ineligible", reason: "catalog_unverified" });
});

test("free admission uses OmniRoute's existing exact provider model catalog", async () => {
  const listedFreeModel = FREE_MODEL_BUDGETS.find((entry) => entry.freeType !== "discontinued");
  assert.ok(listedFreeModel);

  const listedRoute = await checkFreeRouteAdmission(
    listedFreeModel.provider,
    listedFreeModel.modelId
  );
  const unlistedSibling = await checkFreeRouteAdmission(
    listedFreeModel.provider,
    `${listedFreeModel.modelId}-paid-sibling`
  );

  assert.deepEqual(listedRoute, {
    kind: "eligible",
    source: "omniroute.free_model_catalog",
  });
  assert.deepEqual(unlistedSibling, { kind: "ineligible", reason: "not_free" });
});

test("free admission uses a fresh exact free verdict from the selected provider catalog", async () => {
  await coreDb.ensureDbInitialized();
  const retrievedAt = new Date().toISOString();
  await modelsDb.replaceSyncedAvailableModelsForConnection("groq", "groq-free-catalog-test", [
    {
      id: "llama/free-catalog-model",
      name: "Free catalog model",
      isFree: true,
      catalogRetrievedAt: retrievedAt,
    },
    {
      id: "llama/paid-catalog-model",
      name: "Paid catalog model",
      isFree: false,
      catalogRetrievedAt: retrievedAt,
    },
  ]);
  await modelsDb.replaceSyncedAvailableModelsForConnection("groq", "groq-paid-catalog-test", [
    {
      id: "llama/free-catalog-model",
      name: "Account-specific paid verdict",
      isFree: false,
      catalogRetrievedAt: retrievedAt,
    },
  ]);

  assert.deepEqual(
    await checkFreeRouteAdmission("groq", "llama/free-catalog-model", "groq-free-catalog-test"),
    {
      kind: "eligible",
      source: "provider_model_catalog",
    }
  );
  assert.deepEqual(
    await checkFreeRouteAdmission("groq", "llama/free-catalog-model", "groq-paid-catalog-test"),
    {
      kind: "ineligible",
      reason: "not_free",
    }
  );
  assert.deepEqual(
    await checkFreeRouteAdmission("groq", "llama/paid-catalog-model", "groq-free-catalog-test"),
    {
      kind: "ineligible",
      reason: "not_free",
    }
  );
});

test("free admission does not use stale provider catalog free verdicts", async () => {
  await coreDb.ensureDbInitialized();
  await modelsDb.replaceSyncedAvailableModelsForConnection("groq", "groq-stale-free-test", [
    {
      id: "llama/stale-free-model",
      name: "Stale free model",
      isFree: true,
      catalogRetrievedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    },
  ]);

  assert.deepEqual(await checkFreeRouteAdmission("groq", "llama/stale-free-model"), {
    kind: "ineligible",
    reason: "catalog_unverified",
  });
});

test("free admission rechecks exact current Hugging Face provider routes", async () => {
  await coreDb.ensureDbInitialized();
  await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", "hf-free-test", [
    {
      id: "org/tool-model",
      name: "Tool model",
      source: "imported",
      providerRoutesRetrievedAt: new Date().toISOString(),
      providerRoutes: [
        { provider: "free-host", status: "live", isFree: true, supportsTools: true },
        { provider: "paid-host", status: "live", isFree: false, supportsTools: true },
        { provider: "unknown-host", status: "live", isFree: true },
      ],
    },
  ]);

  assert.deepEqual(await checkFreeRouteAdmission("huggingface", "org/tool-model:free-host"), {
    kind: "eligible",
    source: "huggingface.router_models_api",
  });
  assert.deepEqual(await checkFreeRouteAdmission("huggingface", "org/tool-model:paid-host"), {
    kind: "ineligible",
    reason: "not_free",
  });
  assert.deepEqual(
    await checkToolCallingRouteAdmission("huggingface", "org/tool-model:free-host"),
    { kind: "eligible", source: "huggingface.router_models_api" }
  );
  assert.deepEqual(
    await checkToolCallingRouteAdmission("huggingface", "org/tool-model:unknown-host"),
    { kind: "ineligible", reason: "unknown" }
  );
});

test("free admission rejects stale Hugging Face provider-route metadata", async () => {
  await coreDb.ensureDbInitialized();
  await modelsDb.replaceSyncedAvailableModelsForConnection("huggingface", "hf-free-stale", [
    {
      id: "org/stale-model",
      name: "Stale model",
      source: "imported",
      providerRoutesRetrievedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      providerRoutes: [{ provider: "free-host", status: "live", isFree: true }],
    },
  ]);

  assert.deepEqual(await checkFreeRouteAdmission("huggingface", "org/stale-model:free-host"), {
    kind: "ineligible",
    reason: "catalog_unverified",
  });
});

test("tool admission uses the exact selected connection's synced capability verdict", async () => {
  await coreDb.ensureDbInitialized();
  await modelsDb.replaceSyncedAvailableModelsForConnection("groq", "groq-tools-test", [
    {
      id: "llama/tool-model",
      name: "Tool model",
      source: "imported",
      supportsTools: true,
      catalogRetrievedAt: new Date().toISOString(),
    },
    {
      id: "llama/no-tools-model",
      name: "No tools model",
      source: "imported",
      supportsTools: false,
      catalogRetrievedAt: new Date().toISOString(),
    },
    {
      id: "llama/stale-tools-model",
      name: "Stale tool model",
      source: "imported",
      supportsTools: true,
      catalogRetrievedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    },
  ]);

  assert.deepEqual(
    await checkToolCallingRouteAdmission("groq", "llama/tool-model", "groq-tools-test"),
    { kind: "eligible", source: "provider_model_catalog" }
  );
  assert.deepEqual(
    await checkToolCallingRouteAdmission("groq", "llama/no-tools-model", "groq-tools-test"),
    { kind: "ineligible", reason: "unsupported" }
  );
  assert.deepEqual(
    await checkToolCallingRouteAdmission("groq", "llama/stale-tools-model", "groq-tools-test"),
    { kind: "ineligible", reason: "catalog_unverified" }
  );
  assert.notDeepEqual(
    await checkToolCallingRouteAdmission("groq", "llama/tool-model", "different-connection"),
    { kind: "eligible", source: "provider_model_catalog" },
    "one account's discovery must not qualify the same route on another account"
  );
});

test("tool admission rejects stale models.dev capability evidence", async () => {
  await coreDb.ensureDbInitialized();
  modelsDevSync.saveModelsDevCapabilities({
    openai: {
      "omni-stale-capability-fixture": {
        tool_call: true,
        reasoning: null,
        attachment: null,
        structured_output: null,
        temperature: null,
        modalities_input: "[]",
        modalities_output: "[]",
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
      },
    },
  });
  const staleRetrievedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  coreDb
    .getDbInstance()
    .prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
    .run(
      "models_dev_sync_status",
      "last_sync",
      JSON.stringify({
        lastSync: staleRetrievedAt,
        sourceRetrievedAt: staleRetrievedAt,
        modelCount: 1,
        capabilityCount: 1,
      })
    );

  const admission = await checkToolCallingRouteAdmission("openai", "omni-stale-capability-fixture");

  assert.deepEqual(admission, { kind: "ineligible", reason: "catalog_unverified" });
  modelsDevSync.saveModelsDevCapabilities({});
  coreDb
    .getDbInstance()
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run("models_dev_sync_status", "last_sync");
});
