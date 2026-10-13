import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-free-route-admission-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_CATALOG_TTL_MS = "60000";

const { checkFreeRouteAdmission } =
  await import("../../open-sse/handlers/chatCore/freeRouteAdmission.ts");
const { FREE_MODEL_BUDGETS } = await import("../../open-sse/config/freeModelCatalog.data.ts");
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
          { id: "acme/model-a:free" },
          { id: "acme/model-a", pricing: { prompt: "0.000001", completion: "0.000002" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const currentFreeRoute = await checkFreeRouteAdmission("openrouter", "acme/model-a:free");
  const paidSibling = await checkFreeRouteAdmission("openrouter", "acme/model-a");
  const dynamicRouter = await checkFreeRouteAdmission("openrouter", "free");

  assert.deepEqual(currentFreeRoute, { kind: "eligible", source: "openrouter.models_api" });
  assert.deepEqual(paidSibling, { kind: "ineligible", reason: "not_free" });
  assert.deepEqual(dynamicRouter, { kind: "eligible", source: "openrouter.models_api" });
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

  assert.deepEqual(staleRoute, { kind: "ineligible", reason: "catalog_unverified" });
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
