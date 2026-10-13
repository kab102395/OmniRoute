import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import {
  MODEL_PRICING_PROVENANCE_STATES,
  type ModelCatalogEntry,
} from "@/domain/modelCatalogContract";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<
    string,
    {
      get?: {
        parameters?: Array<{ name?: string; in?: string }>;
        description?: string;
      };
      post?: {
        responses?: Record<
          string,
          {
            headers?: Record<string, { schema?: { type?: string; enum?: unknown[] } }>;
          }
        >;
      };
    }
  >;
  components: {
    schemas: {
      Model: {
        properties: {
          [name: string]: unknown;
          capabilities: { properties: Record<string, unknown> };
          supported_endpoints: {
            type: string;
            description: string;
            items: { type: string };
          };
          pricing_provenance: {
            properties: {
              state: { enum: string[] };
              resolvedModelId: { type: string };
              rates: {
                properties: {
                  videoReportedUsd?: { type: string; nullable?: boolean };
                  inputCacheMiss?: {
                    properties: { offPeak: { type: string }; peak: { type: string } };
                  };
                  inputCacheHit?: {
                    properties: { offPeak: { type: string }; peak: { type: string } };
                  };
                  output?: {
                    properties: { offPeak: { type: string }; peak: { type: string } };
                  };
                };
              };
            };
          };
          route_selection: {
            description: string;
            properties: {
              kind: { enum: string[] };
              exactModelIdentity: { type: string };
            };
          };
          route_availability: {
            properties: {
              catalogListed: { type: string; nullable: boolean };
              accountEligibility: { enum: string[] };
              source: {
                properties: {
                  id: { type: string };
                  modelId: { type: string };
                  retrievedAt: { format: string; nullable: boolean };
                  stale: { type: string };
                  cacheTtlMs: { type: string };
                };
              };
              downstreamHostSelection: { enum: string[] };
            };
          };
        };
      };
    };
  };
};

test("model catalog OpenAPI covers every pricing provenance state emitted by OmniRoute", () => {
  const documentedStates = new Set(
    spec.components.schemas.Model.properties.pricing_provenance.properties.state.enum
  );
  assert.deepEqual(
    documentedStates,
    new Set(MODEL_PRICING_PROVENANCE_STATES),
    "OpenAPI and the runtime pricing provenance contract must contain the same states"
  );
});

test("model catalog OpenAPI exposes provider-resolved pricing identity", () => {
  assert.equal(
    spec.components.schemas.Model.properties.pricing_provenance.properties.resolvedModelId.type,
    "string"
  );
});

test("model catalog OpenAPI types emitted effort tiers and supported endpoints", () => {
  const properties = spec.components.schemas.Model.properties;
  assert.deepEqual(properties.capabilities.properties.effort_tiers, {
    type: "array",
    items: { type: "string" },
  });
  assert.deepEqual(properties.supported_endpoints, {
    type: "array",
    description: "API endpoint types supported by this synchronized model route, when reported.",
    items: { type: "string" },
  });
});

test("typed model catalog entries expose supported endpoints", () => {
  const model: ModelCatalogEntry = { id: "provider/model", supported_endpoints: ["chat"] };
  assert.deepEqual(model.supported_endpoints, ["chat"]);
});

test("model catalog OpenAPI includes every emitted OpenRouter modality price dimension", () => {
  const rates =
    spec.components.schemas.Model.properties.pricing_provenance.properties.rates.properties;
  assert.deepEqual(rates.videoReportedUsd, { type: "string", nullable: true });
});

test("model catalog OpenAPI preserves exact decimal conditional pricing schedules", () => {
  const rates =
    spec.components.schemas.Model.properties.pricing_provenance.properties.rates.properties;
  for (const field of ["inputCacheMiss", "inputCacheHit", "output"] as const) {
    assert.equal(rates[field]?.properties.offPeak.type, "string");
    assert.equal(rates[field]?.properties.peak.type, "string");
  }
});

test("model catalog OpenAPI documents the implemented routing filters", () => {
  const operation = spec.paths["/api/v1/models"]?.get;
  const queryParameters = new Set(
    operation?.parameters
      ?.filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name)
  );

  for (const name of ["prefix", "configuredOnly", "free_only", "require_tool_calling"]) {
    assert.ok(queryParameters.has(name), `query parameter ${name} must be documented`);
  }
  assert.match(operation?.description ?? "", /fresh upstream catalog/i);
  assert.match(operation?.description ?? "", /stale facts remain available.*cannot qualify/i);
  assert.match(operation?.description ?? "", /free_access/);
});

test("completion pricing freshness header uses its runtime string representation", () => {
  const headers = spec.paths["/api/v1/chat/completions"]?.post?.responses?.["200"]?.headers;
  assert.deepEqual(headers?.["X-OmniRoute-Pricing-Stale"]?.schema, {
    type: "string",
    enum: ["true", "false"],
  });
});

test("served model header documents the source used to identify the effective model", () => {
  const header =
    spec.paths["/api/v1/chat/completions"]?.post?.responses?.["200"]?.headers?.[
      "X-OmniRoute-Served-Model-Source"
    ];
  assert.deepEqual(header?.schema, {
    type: "string",
    enum: ["provider_response", "outbound_request"],
  });
});

test("OmniRoute keeps catalog and execution facts needed by external routers", () => {
  const modelProperties = spec.components.schemas.Model.properties;
  for (const field of [
    "pricing_provenance",
    "capability_status",
    "free_access",
    "route_selection",
    "route_availability",
    "supported_parameters",
    "provider_routes",
    "provider_routes_provenance",
  ]) {
    assert.ok(field in modelProperties, `Model schema must preserve ${field}`);
  }

  const headers = spec.paths["/api/v1/chat/completions"]?.post?.responses?.["200"]?.headers;
  for (const header of [
    "X-OmniRoute-Request-Id",
    "X-OmniRoute-Provider-Request-Id",
    "X-OmniRoute-Served-Provider",
    "X-OmniRoute-Served-Model",
    "X-OmniRoute-Served-Model-Source",
    "X-OmniRoute-Accounting-Kind",
    "X-OmniRoute-Response-Cost",
    "X-OmniRoute-Cost-Source",
    "X-OmniRoute-Cost-Currency",
    "X-OmniRoute-Usage-Kind",
    "X-OmniRoute-Pricing-Retrieved-At",
    "X-OmniRoute-Pricing-Condition",
    "X-OmniRoute-Pricing-Stale",
    "X-OmniRoute-Fallback-Attempts",
  ]) {
    assert.ok(headers && header in headers, `completion response must document ${header}`);
  }
});

test("model catalog distinguishes exact free variants from the dynamic OpenRouter router", () => {
  const properties = spec.components.schemas.Model.properties;
  assert.deepEqual(properties.route_selection.properties.kind.enum, [
    "exact_model",
    "dynamic_free_model",
  ]);
  assert.equal(properties.route_selection.properties.exactModelIdentity.type, "boolean");

  const availability = properties.route_availability.properties;
  assert.deepEqual(availability.accountEligibility.enum, ["unknown"]);
  assert.deepEqual(availability.downstreamHostSelection.enum, ["aggregator_selected", "pinned"]);
  assert.deepEqual(availability.catalogListed, { type: "boolean", nullable: true });
  assert.equal(availability.source.properties.id.type, "string");
  assert.equal(availability.source.properties.modelId.type, "string");
  assert.equal(availability.source.properties.retrievedAt.format, "date-time");
  assert.equal(availability.source.properties.retrievedAt.nullable, true);
  assert.equal(availability.source.properties.stale.type, "boolean");
  assert.equal(availability.source.properties.cacheTtlMs.type, "integer");

  const catalogDescription = spec.paths["/api/v1/models"]?.get?.description ?? "";
  assert.match(catalogDescription, /exact OpenRouter free variants/i);
  assert.match(properties.route_selection.description, /does not pin the model selected/i);
});
