import test from "node:test";
import assert from "node:assert/strict";

import { discoverOpenRouterFreeModels } from "../../src/lib/catalog/openrouterFreeModels.ts";

test("discoverOpenRouterFreeModels follows exact free variants regardless of numeric price fields", () => {
  const models = discoverOpenRouterFreeModels(
    [
      {
        id: "provider/suffix:free",
        name: "Free variant",
        pricing: { prompt: "0.000001", completion: "0.000002" },
        architecture: { output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"],
      },
      { id: "provider/unpriced:free" },
      { id: "provider/zero-priced", pricing: { prompt: "0", completion: "0" } },
      {
        id: "provider/paid",
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.deepEqual(
    models.map((model) => model.modelId),
    ["provider/suffix:free", "provider/unpriced:free", "provider/zero-priced"]
  );
  assert.equal(models[0]?.poolKey, "openrouter-free");
  assert.equal(models[0]?.supportsTools, true);
  assert.equal(models[0]?.supportsReasoning, true);
  assert.equal(models[0]?.lastSeenAt, "2026-09-11T00:00:00.000Z");
  assert.equal(models[0]?.routeId, "openrouter/provider/suffix:free");
  assert.equal(models[0]?.freeEligibility, "verified_free_variant");
});

test("discoverOpenRouterFreeModels deduplicates ids and supplies safe defaults", () => {
  const [model] = discoverOpenRouterFreeModels(
    [
      {
        id: "provider/model:free",
      },
      {
        id: "provider/model:free",
        name: "Duplicate",
      },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.equal(model?.displayName, "provider/model:free");
  assert.deepEqual(model?.modalities, []);
  assert.equal(model?.contextWindow, null);
  assert.equal(model?.tos, "caution");
});

test("discoverOpenRouterFreeModels ignores malformed and non-free entries", () => {
  const models = discoverOpenRouterFreeModels(
    [
      { id: "", pricing: { prompt: "0", completion: "0" } },
      { id: "provider/paid", pricing: { prompt: "1", completion: "1" } },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.deepEqual(models, []);
});
