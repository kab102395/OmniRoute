import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogFreeAccess } from "../../src/app/api/v1/models/catalogFreeAccess.ts";

test("catalog free access preserves the exact provider/model and free-tier regime", () => {
  const route = getCatalogFreeAccess("groq", "openai/gpt-oss-120b");
  assert.ok(route);
  assert.equal(route.classification, "documented_free_tier");
  assert.equal(route.freeType, "recurring-daily");
  assert.equal(route.hardStopGuaranteed, true);
  assert.equal(route.zeroCostOnExhaustion, "provider_hard_stop");
  assert.equal(route.accountEligibility, "unknown");
  assert.equal(route.source.freshness, "release_catalog");
  assert.equal(route.source.retrievedAt, null);
});

test("catalog free access does not extend to a paid sibling or static OpenRouter entry", () => {
  assert.equal(getCatalogFreeAccess("groq", "openai/gpt-oss-120b-paid"), null);
  assert.equal(getCatalogFreeAccess("openrouter", "liquid/lfm-2.5-2.6b:free"), null);
});
