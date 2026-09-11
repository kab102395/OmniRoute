import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHomeProviderUsageRows,
  formatHomeUsageNumber,
} from "../../src/app/(dashboard)/dashboard/HomeUsageOverview";

test("aggregates provider usage and attaches the latest connected quota", () => {
  const rows = buildHomeProviderUsageRows(
    [
      { provider: "Mistral AI", requests: 3, totalTokens: 1200, successfulRequests: 2 },
      { provider: "mistral", requests: 2, totalTokens: 800, successfulRequests: 2 },
    ],
    {
      "connection-1": {
        quotas: { monthly: { used: 2000, total: 1_000_000_000, remaining: 999_998_000 } },
      },
    },
    [{ id: "connection-1", provider: "mistral", isActive: true }]
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "mistral");
  assert.equal(rows[0].requests, 5);
  assert.equal(rows[0].totalTokens, 2000);
  assert.equal(rows[0].successfulRequests, 4);
  assert.equal(rows[0].quota?.remaining, 999_998_000);
});

test("formats routed token totals compactly", () => {
  assert.equal(formatHomeUsageNumber(999), "999");
  assert.equal(formatHomeUsageNumber(12_345), "12.3K");
  assert.equal(formatHomeUsageNumber(12_345_678), "12.3M");
  assert.equal(formatHomeUsageNumber(1_234_567_890), "1.2B");
});
