import test from "node:test";
import assert from "node:assert/strict";

import { getMcpModelsCatalog } from "../../open-sse/mcp-server/server.ts";
import { listModelsCatalogOutput } from "../../open-sse/mcp-server/schemas/tools.ts";

test("getMcpModelsCatalog aggregates only active connection model endpoints", async () => {
  const calls: string[] = [];

  const result = await getMcpModelsCatalog(
    {},
    {
      listProviderConnections: async () => [
        { id: "conn-github", provider: "github", isActive: true },
        { id: "conn-codex", provider: "codex", isActive: false },
      ],
      fetchJson: async (path: string) => {
        calls.push(path);
        if (path === "/api/providers/conn-github/models?excludeHidden=true") {
          return {
            source: "api",
            models: [
              { id: "gpt-4.1", owned_by: "github", supportedEndpoints: ["chat"] },
              {
                id: "text-embedding-3-small",
                owned_by: "github",
                supportedEndpoints: ["embeddings"],
              },
            ],
          };
        }

        throw new Error(`Unexpected path: ${path}`);
      },
    }
  );

  assert.deepEqual(calls, ["/api/providers/conn-github/models?excludeHidden=true"]);
  assert.deepEqual(result, {
    models: [
      {
        id: "gpt-4.1",
        provider: "github",
        capabilities: ["chat"],
        status: "available",
        toolCallingStatus: "unknown",
        pricing: undefined,
      },
      {
        id: "text-embedding-3-small",
        provider: "github",
        capabilities: ["embedding"],
        status: "available",
        toolCallingStatus: "unknown",
        pricing: undefined,
      },
    ],
    source: "api",
  });
});

test("getMcpModelsCatalog preserves route eligibility, limits, and price evidence", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "openrouter" },
    {
      listProviderConnections: async () => [
        { id: "conn-openrouter", provider: "openrouter", isActive: true },
      ],
      fetchJson: async () => ({
        source: "api",
        models: [
          {
            id: "openrouter/vendor/coder:free",
            owned_by: "openrouter",
            supportedEndpoints: ["chat-completions"],
            context_length: 65536,
            max_output_tokens: 8192,
            pricing: { prompt: "0", completion: "0" },
            pricing_provenance: {
              state: "free_variant",
              zeroCostEligibility: "verified_free_variant",
              source: { id: "openrouter.models_api", stale: false },
            },
            capability_status: {
              tool_calling: { status: "supported", source: "openrouter.models_api" },
              structured_output: { status: "supported", source: "openrouter.models_api" },
            },
            supported_parameters: ["tools", "response_format"],
            input_modalities: ["text", "image"],
            output_modalities: ["text"],
            free: true,
            route_selection: { kind: "exact_model", exactModelIdentity: true },
            route_availability: {
              catalogListed: true,
              accountEligibility: "unknown",
            },
          },
        ],
      }),
    }
  );

  const model = result.models[0];
  assert.equal(model?.toolCallingStatus, "supported");
  assert.equal(model?.contextLength, 65536);
  assert.equal(model?.maxOutputTokens, 8192);
  assert.deepEqual(model?.pricing, { prompt: "0", completion: "0" });
  assert.equal(model?.pricingProvenance?.state, "free_variant");
  assert.deepEqual(model?.capabilityStatus?.structured_output, {
    status: "supported",
    source: "openrouter.models_api",
  });
  assert.deepEqual(model?.supportedParameters, ["tools", "response_format"]);
  assert.deepEqual(model?.inputModalities, ["text", "image"]);
  assert.deepEqual(model?.outputModalities, ["text"]);
  assert.deepEqual(model?.routeSelection, { kind: "exact_model", exactModelIdentity: true });
  assert.equal(listModelsCatalogOutput.parse(result).models[0]?.toolCallingStatus, "supported");
});

test("explicit unknown tool support is not promoted by a legacy capability hint", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "openrouter" },
    {
      listProviderConnections: async () => [
        { id: "conn-openrouter", provider: "openrouter", isActive: true },
      ],
      fetchJson: async () => ({
        source: "api",
        models: [
          {
            id: "vendor/unknown-tools",
            owned_by: "openrouter",
            supports_tools: true,
            capability_status: { tool_calling: { status: "unknown" } },
          },
        ],
      }),
    }
  );

  assert.equal(result.models[0]?.toolCallingStatus, "unknown");
});

test("getMcpModelsCatalog exposes codex default thinking effort when no override is stored", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "codex" },
    {
      listProviderConnections: async () => [
        {
          id: "conn-codex",
          provider: "codex",
          isActive: true,
          providerSpecificData: {},
        },
      ],
      fetchJson: async () => ({
        source: "api",
        models: [{ id: "gpt-5.5", owned_by: "codex", supportedEndpoints: ["chat"] }],
      }),
    }
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.thinkingEffort, "medium");
});

test("getMcpModelsCatalog exposes stored thinking effort overrides", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "gemini-web" },
    {
      listProviderConnections: async () => [
        {
          id: "conn-gemini-web",
          provider: "gemini-web",
          isActive: true,
          providerSpecificData: { thinkingEffort: "extended" },
        },
      ],
      fetchJson: async () => ({
        source: "api",
        models: [{ id: "gemini-3.1-pro", owned_by: "gemini-web", supportedEndpoints: ["chat"] }],
      }),
    }
  );

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.thinkingEffort, "extended");
});

test("getMcpModelsCatalog resolves provider aliases to active connection ids", async () => {
  const calls: string[] = [];

  const result = await getMcpModelsCatalog(
    { provider: "gh", capability: "chat" },
    {
      listProviderConnections: async () => [
        { id: "conn-github", provider: "github", isActive: true },
        { id: "conn-codex", provider: "codex", isActive: true },
      ],
      fetchJson: async (path: string) => {
        calls.push(path);
        return {
          source: "api",
          models: [{ id: "gpt-4.1", owned_by: "github", supportedEndpoints: ["chat"] }],
        };
      },
    }
  );

  assert.deepEqual(calls, ["/api/providers/conn-github/models?excludeHidden=true"]);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0]?.provider, "github");
  assert.deepEqual(result.models[0]?.capabilities, ["chat"]);
});

test("getMcpModelsCatalog returns empty result when requested provider has no active connection", async () => {
  const result = await getMcpModelsCatalog(
    { provider: "github" },
    {
      listProviderConnections: async () => [
        { id: "conn-codex", provider: "codex", isActive: true },
      ],
      fetchJson: async () => {
        throw new Error("fetchJson should not be called without a matching active provider");
      },
    }
  );

  assert.deepEqual(result, {
    models: [],
    source: "provider_connections",
    warning: "No active connections found for provider 'github'.",
  });
});
