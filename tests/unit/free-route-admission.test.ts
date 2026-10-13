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
