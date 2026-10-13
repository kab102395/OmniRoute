import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<
    string,
    {
      get?: {
        parameters?: Array<{ name?: string; in?: string }>;
        description?: string;
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
  const emittedStates = [
    "free_variant",
    "reported",
    "conditional_reported_pricing",
    "third_party_reported_pricing",
    "estimated_pricing",
    "unverified_pricing",
    "incomplete",
    "unavailable",
    "unknown_stale_catalog",
    "not_in_current_free_catalog",
  ];

  for (const state of emittedStates) {
    assert.ok(documentedStates.has(state), `pricing provenance state ${state} must be documented`);
  }
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
