import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import { MODEL_PRICING_PROVENANCE_STATES } from "@/domain/modelCatalogContract";

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
          pricing_provenance: {
            properties: { state: { enum: string[] } };
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

test("model catalog OpenAPI documents the implemented routing filters", () => {
  const operation = spec.paths["/api/v1/models"]?.get;
  const queryParameters = new Set(
    operation?.parameters
      ?.filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name)
  );

  for (const name of ["prefix", "configuredOnly", "free_only"]) {
    assert.ok(queryParameters.has(name), `query parameter ${name} must be documented`);
  }
  assert.match(operation?.description ?? "", /fresh upstream catalog/i);
  assert.match(operation?.description ?? "", /free_access/);
});

test("completion pricing freshness header uses its runtime string representation", () => {
  const headers = spec.paths["/api/v1/chat/completions"]?.post?.responses?.["200"]?.headers;
  assert.deepEqual(headers?.["X-OmniRoute-Pricing-Stale"]?.schema, {
    type: "string",
    enum: ["true", "false"],
  });
});
