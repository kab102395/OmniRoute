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
        context_length: 64000,
        top_provider: { max_completion_tokens: 8192 },
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning", "structured_outputs", "parallel_tool_calls"],
      },
      { id: "provider/unpriced:free" },
      {
        id: "provider/zero-priced",
        pricing: { prompt: "0", completion: "0" },
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
      {
        id: "google/lyria-3-pro-preview",
        pricing: { prompt: "0", completion: "0" },
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
      },
      {
        id: "openrouter/free",
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: ["tools"],
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
    ["provider/suffix:free", "provider/unpriced:free", "provider/zero-priced"]
  );
  assert.equal(models[0]?.poolKey, "openrouter-free");
  assert.equal(models[0]?.supportsTools, true);
  assert.equal(models[0]?.supportsReasoning, true);
  assert.equal(models[0]?.supportsStructuredOutput, true);
  assert.equal(models[0]?.contextWindow, 64000);
  assert.equal(models[0]?.maxOutputTokens, 8192);
  assert.deepEqual(models[0]?.inputModalities, ["text", "image"]);
  assert.deepEqual(models[0]?.outputModalities, ["text"]);
  assert.deepEqual(models[0]?.modalities, ["text"]);
  assert.deepEqual(models[0]?.supportedParameters, [
    "tools",
    "reasoning",
    "structured_outputs",
    "parallel_tool_calls",
  ]);
  assert.equal(models[0]?.lastSeenAt, "2026-09-11T00:00:00.000Z");
  assert.equal(models[0]?.catalogRetrievedAt, "2026-09-11T00:00:00.000Z");
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
  assert.deepEqual(model?.inputModalities, []);
  assert.deepEqual(model?.outputModalities, []);
  assert.deepEqual(model?.supportedParameters, []);
  assert.equal(model?.contextWindow, null);
  assert.equal(model?.maxOutputTokens, null);
  assert.equal(model?.supportsStructuredOutput, null);
  assert.equal(model?.tos, "caution");
});

test("discoverOpenRouterFreeModels omits malformed context and output limits", () => {
  const [model] = discoverOpenRouterFreeModels(
    [
      {
        id: "provider/model:free",
        context_length: Number.NaN,
        top_provider: { max_completion_tokens: -1 },
      },
    ],
    "2026-09-11T00:00:00.000Z"
  );

  assert.equal(model?.contextWindow, null);
  assert.equal(model?.maxOutputTokens, null);
});

test("discovery does not invent a catalog refresh timestamp when none is available", () => {
  const [model] = discoverOpenRouterFreeModels([{ id: "provider/model:free" }], "");

  assert.equal(model?.lastSeenAt, "");
  assert.equal(model?.catalogRetrievedAt, null);
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

test("stale discovery preserves exact route metadata without claiming current eligibility", () => {
  const [model] = discoverOpenRouterFreeModels(
    [
      {
        id: "provider/tool-model:free",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        supported_parameters: ["tools"],
      },
    ],
    "2026-09-11T00:00:00.000Z",
    true
  );

  assert.equal(model?.routeId, "openrouter/provider/tool-model:free");
  assert.equal(model?.catalogAvailability, "stale");
  assert.equal(model?.freeEligibility, "unknown_stale_catalog");
  assert.equal(model?.catalogRetrievedAt, "2026-09-11T00:00:00.000Z");
  assert.equal(model?.supportsTools, true);
  assert.deepEqual(model?.inputModalities, ["text"]);
  assert.deepEqual(model?.outputModalities, ["text"]);
});
