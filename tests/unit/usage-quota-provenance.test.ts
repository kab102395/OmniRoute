import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

import { buildQuotaEntry } from "../../src/app/api/usage/quota/route.ts";
import { normalizeQuotaResponse } from "../../src/shared/contracts/quota.ts";

const connection = { id: "connection-1", provider: "openai", name: "OpenAI" };
const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<
    string,
    { get?: { responses?: Record<string, { content?: Record<string, unknown> }> } }
  >;
};

test("quota OpenAPI exposes source and retrieval time for remaining-capacity values", () => {
  const response = spec.paths["/api/usage/quota"]?.get?.responses?.["200"];
  assert.ok(response?.content?.["application/json"]);
  const body = response.content["application/json"] as {
    schema: {
      properties: {
        providers: {
          items: {
            properties: Record<string, { enum?: string[]; nullable?: boolean }>;
          };
        };
      };
    };
  };
  const properties = body.schema.properties.providers.items.properties;
  assert.deepEqual(properties.quotaSource.enum, [
    "learned_limit",
    "observed_rate_limit",
    "observed_queue_pressure",
    "unknown",
  ]);
  assert.equal(properties.quotaRetrievedAt.nullable, true);
});

test("quota response identifies missing account capacity as unknown", () => {
  const entry = buildQuotaEntry(connection, null, { queued: 0, running: 0, executing: 0 });
  assert.equal(entry.quotaTotal, null);
  assert.equal(entry.percentRemaining, 100, "the legacy numeric field remains backward compatible");
  assert.equal(entry.quotaSource, "unknown");
  assert.equal(entry.quotaRetrievedAt, null);

  const normalized = normalizeQuotaResponse({ providers: [entry] }).providers[0];
  assert.equal(normalized?.quotaSource, "unknown");
});

test("learned limits without a remaining count do not imply full remaining quota", () => {
  const entry = buildQuotaEntry(
    connection,
    { limit: 1000, lastUpdated: Date.parse("2026-10-12T00:00:00.000Z") },
    {}
  );
  assert.equal(entry.quotaTotal, 1000);
  assert.equal(entry.quotaSource, "unknown");
  assert.equal(entry.quotaRetrievedAt, null);
});

test("learned quota, rate-limit, and queue observations keep separate provenance", () => {
  const learned = buildQuotaEntry(
    connection,
    {
      limit: 1000,
      remaining: 250,
      lastUpdated: Date.parse("2026-10-13T00:00:00.000Z"),
    },
    {}
  );
  assert.equal(learned.quotaSource, "learned_limit");
  assert.equal(learned.percentRemaining, 25);
  assert.equal(learned.quotaRetrievedAt, "2026-10-13T00:00:00.000Z");

  const rateLimited = buildQuotaEntry(
    { ...connection, rateLimitedUntil: new Date(Date.now() + 60_000).toISOString() },
    null,
    {}
  );
  assert.equal(rateLimited.quotaSource, "observed_rate_limit");
  assert.equal(rateLimited.percentRemaining, 0);

  const queuePressure = buildQuotaEntry(connection, null, { queued: 2, running: 1, executing: 0 });
  assert.equal(queuePressure.quotaSource, "observed_queue_pressure");
  assert.equal(queuePressure.percentRemaining, 75);
});
