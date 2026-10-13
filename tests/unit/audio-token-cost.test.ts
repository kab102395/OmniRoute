import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-audio-cost-"));
process.env.DATA_DIR = DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const { calculateCostWithEvidence, computeCostFromPricing } =
  await import("../../src/lib/usage/costCalculator.ts");

test("audio tokens use dedicated input/output rates without double billing generic token rates", () => {
  assert.equal(
    computeCostFromPricing(
      { input: 1, output: 2, input_audio: 10, output_audio: 20 },
      {
        input: 100,
        output: 80,
        input_audio_tokens: 25,
        output_audio_tokens: 30,
      }
    ),
    0.001025
  );
});

test("audio usage with no dedicated audio pricing remains unknown", async () => {
  await settings.updatePricing({ "audio-cost-test": { "model-a": { input: 1, output: 2 } } });
  const estimate = await calculateCostWithEvidence("audio-cost-test", "model-a", {
    input: 100,
    output: 80,
    input_audio_tokens: 25,
  });

  assert.equal(estimate.costUsd, 0);
  assert.equal(estimate.costKnown, false);
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.DATA_DIR;
});
