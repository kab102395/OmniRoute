import test from "node:test";
import assert from "node:assert/strict";

import { discoverOpenRouterFreeModels } from "../../src/lib/catalog/openrouterFreeModels.ts";

test("discoverOpenRouterFreeModels keeps zero-priced and :free models", () => {
  const models = discoverOpenRouterFreeModels(
    [
      {
        id: "provider/zero-priced",
        name: "Zero priced",
        pricing: { prompt: "0", completion: "0" },
        architecture: { output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"],
      },
      {
        id: "provider/suffix:free",
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
      {
        id: "provider/paid",
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.deepEqual(
    models.map((model) => model.modelId),
    ["provider/suffix:free", "provider/zero-priced"]
  );
  assert.equal(models[1]?.poolKey, "openrouter-free");
  assert.equal(models[1]?.supportsTools, true);
  assert.equal(models[1]?.supportsReasoning, true);
  assert.equal(models[1]?.lastSeenAt, "2026-09-11T00:00:00.000Z");
});

test("discoverOpenRouterFreeModels deduplicates ids and supplies safe defaults", () => {
  const [model] = discoverOpenRouterFreeModels(
    [
      { id: "provider/model", pricing: { prompt: "0", completion: "0" } },
      { id: "provider/model", name: "Duplicate", pricing: { prompt: "0", completion: "0" } },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.equal(model?.displayName, "provider/model");
  assert.deepEqual(model?.modalities, []);
  assert.equal(model?.contextWindow, null);
  assert.equal(model?.tos, "caution");
});

test("discoverOpenRouterFreeModels ignores malformed and non-free entries", () => {
  const models = discoverOpenRouterFreeModels(
    [
      { id: "", pricing: { prompt: "0", completion: "0" } },
      { id: "provider/missing-completion", pricing: { prompt: "0" } },
      { id: "provider/paid", pricing: { prompt: "1", completion: "1" } },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.deepEqual(models, []);
});
