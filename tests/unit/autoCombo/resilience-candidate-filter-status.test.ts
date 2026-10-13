import test from "node:test";
import assert from "node:assert/strict";
import { filterResilienceBlockedCandidates } from "../../../open-sse/services/autoCombo/resilienceCandidateFilter.ts";

const candidate = {
  provider: "openrouter",
  connectionId: "connection-1",
  model: "vendor/model:free",
};

test("auto candidates exclude blocked connection statuses using dispatch normalization", () => {
  for (const testStatus of [
    "unavailable",
    "banned",
    "expired",
    "credits_exhausted",
    "deactivated",
  ]) {
    const actual = filterResilienceBlockedCandidates(
      [candidate],
      new Map([
        ["connection-1", { id: "connection-1", testStatus: ` ${testStatus.toUpperCase()} ` }],
      ])
    );
    assert.deepEqual(actual, [], `${testStatus} should block the candidate`);
  }
});

test("auto candidates remain eligible for active connections despite status formatting", () => {
  const actual = filterResilienceBlockedCandidates(
    [candidate],
    new Map([["connection-1", { id: "connection-1", testStatus: " ACTIVE " }]])
  );
  assert.deepEqual(actual, [candidate]);
});
