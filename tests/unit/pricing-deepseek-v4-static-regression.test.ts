// Regression guard for DeepSeek's current peak-rate estimates and retired model alias.
import { test } from "node:test";
import assert from "node:assert/strict";

const { DEFAULT_PRICING_FRONTIER } =
  await import("../../src/shared/constants/pricing/frontier-labs.ts");

test("deepseek-v4-pro uses current V4.1-Flash peak rates while the provider redirects it", () => {
  const entry = (DEFAULT_PRICING_FRONTIER as Record<string, Record<string, Record<string, number>>>)
    .deepseek["deepseek-v4-pro"];
  assert.ok(entry, "deepseek-v4-pro entry must exist under DEFAULT_PRICING_FRONTIER.deepseek");
  assert.equal(entry.input, 0.3);
  assert.equal(entry.output, 1.2);
  assert.equal(entry.cached, 0.006);
  assert.equal(entry.reasoning, 1.2);
  assert.equal(entry.cache_creation, 0.3);
});

test("deepseek-v4-flash legacy alias and deepseek-flash use peak rates", () => {
  const entry = (DEFAULT_PRICING_FRONTIER as Record<string, Record<string, Record<string, number>>>)
    .deepseek["deepseek-v4-flash"];
  assert.ok(entry, "deepseek-v4-flash entry must exist under DEFAULT_PRICING_FRONTIER.deepseek");
  assert.equal(entry.input, 0.3);
  assert.equal(entry.output, 1.2);
  assert.equal(entry.cached, 0.006);
  assert.equal(entry.reasoning, 1.2);
  assert.equal(entry.cache_creation, 0.3);
  const current = (
    DEFAULT_PRICING_FRONTIER as Record<string, Record<string, Record<string, number>>>
  ).deepseek["deepseek-flash"];
  assert.deepEqual(current, entry);
});

test("DeepSeek route estimates retain published input/output ratios", () => {
  const deepseek = (
    DEFAULT_PRICING_FRONTIER as Record<string, Record<string, Record<string, number>>>
  ).deepseek;
  for (const [model, outputRatio] of [
    ["deepseek-v4-pro", 4],
    ["deepseek-v4-flash", 4],
    ["deepseek-flash", 4],
  ] as const) {
    const entry = deepseek[model];
    assert.equal(
      entry.output,
      entry.input * outputRatio,
      `${model}: expected published output/input ratio ${outputRatio}`
    );
    assert.equal(entry.reasoning, entry.output, `${model}: reasoning should match output`);
    assert.ok(entry.cached < entry.input, `${model}: cached must be cheaper than input`);
  }
});
