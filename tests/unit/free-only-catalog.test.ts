import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitOpenRouterFreeCatalogModel } from "../../src/app/api/v1/models/freeOnlyCatalog.ts";

test("free-only catalog keeps explicit OpenRouter :free entries", () => {
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({ id: "openrouter/google/gemma-4-31b-it:free" }),
    true
  );
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({ id: "openrouter/openai/gpt-5.5" }),
    false
  );
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({ id: "auto/coding:free", owned_by: "combo" }),
    false
  );
  assert.equal(
    isExplicitOpenRouterFreeCatalogModel({ root: "openrouter/minimax/minimax-m3:free" }),
    true
  );
});
