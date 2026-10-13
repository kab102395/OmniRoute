import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFreeModel, providerHasFreeModels } from "../../src/shared/utils/freeModels.ts";

describe("isFreeModel isFree opt-in", () => {
  it("isFree:true → free even without :free/pricing/catalog", () => {
    assert.equal(isFreeModel("any", { id: "x", isFree: true }), true);
    assert.equal(isFreeModel("openai", { id: "gpt-4o", isFree: true }), true);
    assert.equal(isFreeModel("local", { id: "my-model", isFree: true }), true);
  });
  it("isFree:false/null/undefined/1/'true' → not free (strict ===true)", () => {
    const junk: unknown[] = [false, null, undefined, 1, "true"];
    for (const v of junk) {
      assert.equal(
        isFreeModel("any", { id: "x", isFree: v as boolean }),
        false,
        `isFree=${String(v)} should be false`
      );
    }
  });
  it("providerHasFreeModels unchanged by custom isFree", () => {
    assert.equal(providerHasFreeModels("local"), false);
    assert.equal(providerHasFreeModels("openai"), providerHasFreeModels("openai"));
  });
  it("route suffix alone is not free, while authoritative flags and zero prices work", () => {
    assert.equal(isFreeModel("any", { id: "foo:free" }), false);
    assert.equal(isFreeModel("any", { id: "foo:free", isFree: true }), true);
    assert.equal(isFreeModel("any", { id: "foo", pricing: { prompt: 0, completion: 0 } }), true);
    assert.equal(isFreeModel("any", { id: "foo", pricing: { prompt: 0, completion: 1 } }), false);
    assert.equal(
      isFreeModel("any", { id: "foo", pricing: { prompt: 0, completion: 0, image: 0.01 } }),
      false,
      "a nonzero reported billing dimension prevents all-dimensions zero-cost classification"
    );
  });
  it("does not treat missing, empty, or malformed prices as numeric zero", () => {
    for (const price of [undefined, "", " ", "0x0", "NaN", null]) {
      assert.equal(
        isFreeModel("any", {
          id: "foo",
          pricing: { prompt: price as string, completion: "0" },
        }),
        false,
        `prompt price ${String(price)} must not imply free pricing`
      );
    }
    assert.equal(
      isFreeModel("any", { id: "foo", pricing: { prompt: "0.00", completion: "0" } }),
      true
    );
  });
});
