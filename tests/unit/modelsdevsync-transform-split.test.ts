/**
 * Split-guard — modelsDevSync ↔ modelsDevSync/transform
 *
 * Guards the extraction of the pure transform layer (provider-id mapping +
 * raw→OmniRoute pricing/capability transforms) into the leaf
 * src/lib/modelsDevSync/transform.ts. Characterizes the provider map and the
 * two transform functions, and proves the host still re-exports them so its
 * public API is unchanged. DB-free by design — the transform layer is pure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mapProviderId,
  transformModelsDevToPricing,
  transformModelsDevToCapabilities,
  MODELS_DEV_PROVIDER_MAP,
} from "../../src/lib/modelsDevSync/transform.ts";

describe("modelsDevSync/transform split-guard", () => {
  it("maps known models.dev provider ids to OmniRoute aliases", () => {
    assert.deepEqual(mapProviderId("openai"), ["openai", "cx"]);
    assert.deepEqual(mapProviderId("anthropic"), ["anthropic", "cc"]);
    assert.deepEqual(mapProviderId("zai"), ["zai", "glm"]);
    assert.deepEqual(mapProviderId("bedrock"), ["kiro", "kr"]);
    assert.deepEqual(mapProviderId("opencode"), ["opencode", "opencode-zen"]);
  });

  it("falls back to the raw id for unmapped providers", () => {
    assert.deepEqual(mapProviderId("some-unknown-provider"), ["some-unknown-provider"]);
  });

  it("exports a non-trivial provider map table", () => {
    assert.ok(MODELS_DEV_PROVIDER_MAP.openai);
    assert.ok(Object.keys(MODELS_DEV_PROVIDER_MAP).length > 30);
  });

  it("transforms cost → pricing and writes to every mapped provider", () => {
    const raw = {
      openai: {
        id: "openai",
        models: {
          "gpt-x": {
            id: "gpt-x",
            name: "GPT-X",
            cost: {
              input: 1,
              output: 2,
              cache_read: 0.5,
              cache_write: 3,
              reasoning: 4,
              input_audio: 5,
              output_audio: 6,
            },
          },
        },
      },
    };
    const pricing = transformModelsDevToPricing(raw as never);
    assert.deepEqual(pricing.openai["gpt-x"], {
      input: 1,
      output: 2,
      cached: 0.5,
      cache_creation: 3,
      reasoning: 4,
      input_audio: 5,
      output_audio: 6,
    });
    // openai maps to ["openai", "cx"] — both must receive the entry.
    assert.deepEqual(pricing.cx["gpt-x"], pricing.openai["gpt-x"]);
  });

  it("keeps Together direct-route metadata out of OpenRouter route records", () => {
    const raw = {
      togetherai: {
        id: "togetherai",
        models: {
          "meta-llama/Llama-4-Maverick": {
            id: "meta-llama/Llama-4-Maverick",
            name: "Llama 4 Maverick",
            cost: { input: 0.2, output: 0.6 },
            tool_call: true,
            limit: { context: 1_000_000 },
          },
        },
      },
    };
    const pricing = transformModelsDevToPricing(raw as never);
    const capabilities = transformModelsDevToCapabilities(raw as never);

    assert.deepEqual(pricing.together["meta-llama/Llama-4-Maverick"], {
      input: 0.2,
      output: 0.6,
    });
    assert.equal(pricing.openrouter, undefined);
    assert.equal(capabilities.together["meta-llama/Llama-4-Maverick"].tool_call, true);
    assert.equal(capabilities.openrouter, undefined);
  });

  it("drops malformed optional billing dimensions instead of persisting unsafe values", () => {
    const raw = {
      openai: {
        id: "openai",
        models: {
          "gpt-x": {
            id: "gpt-x",
            name: "GPT-X",
            cost: {
              input: 1,
              output: 2,
              input_audio: Number.NaN,
              output_audio: -1,
              cache_read: "0",
            },
          },
        },
      },
    };
    const pricing = transformModelsDevToPricing(raw as never);
    assert.deepEqual(pricing.openai["gpt-x"], { input: 1, output: 2 });
  });

  it("skips models with no cost or missing input pricing", () => {
    const raw = {
      openai: {
        id: "openai",
        models: {
          "no-cost": { id: "no-cost", name: "x" },
          "no-input": { id: "no-input", name: "y", cost: { output: 5 } },
        },
      },
    };
    const pricing = transformModelsDevToPricing(raw as never);
    assert.equal(pricing.openai, undefined);
  });

  it("transforms capabilities incl. interleaved=true → reasoning_content", () => {
    const raw = {
      anthropic: {
        id: "anthropic",
        models: {
          "claude-x": {
            id: "claude-x",
            name: "Claude X",
            tool_call: true,
            reasoning: true,
            interleaved: true,
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
    };
    const caps = transformModelsDevToCapabilities(raw as never);
    assert.equal(caps.anthropic["claude-x"].tool_call, true);
    assert.equal(caps.anthropic["claude-x"].interleaved_field, "reasoning_content");
    assert.equal(caps.anthropic["claude-x"].modalities_input, JSON.stringify(["text", "image"]));
    // anthropic maps to ["anthropic", "cc"].
    assert.deepEqual(caps.cc["claude-x"], caps.anthropic["claude-x"]);
  });

  it("host re-exports the pure transform functions (public API preserved)", async () => {
    const host = await import("../../src/lib/modelsDevSync.ts");
    assert.equal(typeof host.mapProviderId, "function");
    assert.equal(typeof host.transformModelsDevToPricing, "function");
    assert.equal(typeof host.transformModelsDevToCapabilities, "function");
    assert.deepEqual(host.mapProviderId("anthropic"), mapProviderId("anthropic"));
  });
});
