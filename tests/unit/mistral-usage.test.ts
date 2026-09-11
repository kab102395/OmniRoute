import assert from "node:assert/strict";
import test from "node:test";

import { parseMistralRateLimitHeaders } from "../../open-sse/services/usage/mistral.ts";

test("Mistral usage parser exposes request and token windows", () => {
  const result = parseMistralRateLimitHeaders(
    new Headers({
      "x-ratelimit-limit-requests": "60",
      "x-ratelimit-remaining-requests": "45",
      "x-ratelimit-reset-requests": "30s",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "75000",
      "x-ratelimit-reset-tokens": "60s",
    })
  );

  assert.equal(result.hasHeaders, true);
  assert.equal(result.quotas.requests.used, 15);
  assert.equal(result.quotas.requests.total, 60);
  assert.equal(result.quotas.requests.remaining, 45);
  assert.equal(result.quotas.tokens.used, 25000);
  assert.equal(result.quotas.tokens.remaining, 75000);
});

test("Mistral usage parser does not invent quota data", () => {
  const result = parseMistralRateLimitHeaders(new Headers());
  assert.equal(result.hasHeaders, false);
  assert.deepEqual(result.quotas, {});
});
