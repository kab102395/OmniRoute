import assert from "node:assert/strict";
import test from "node:test";
import { mapQuotaRows } from "../../bin/cli/commands/usage.mjs";

test("unknown and observational quota evidence is not shown as token capacity", () => {
  const rows = mapQuotaRows([
    { provider: "unknown", quotaSource: "unknown", percentRemaining: 100 },
    { provider: "queue", quotaSource: "observed_queue_pressure", percentRemaining: 100 },
    { provider: "limited", quotaSource: "observed_rate_limit", percentRemaining: 100 },
  ]);

  assert.deepEqual(rows.map(({ limit, used, remaining }) => [limit, used, remaining]), [
    [null, null, null],
    [null, null, null],
    [null, null, null],
  ]);
  assert.deepEqual(rows.map(({ state }) => state), ["unknown", "queue pressure only", "rate limited"]);
});

test("learned quota shows only observed token capacity", () => {
  const [row] = mapQuotaRows([
    { provider: "learned", quotaSource: "learned_limit", quotaTotal: 1200, quotaUsed: 350 },
  ]);

  assert.equal(row.limit, 1200);
  assert.equal(row.used, 350);
  assert.equal(row.remaining, 850);
  assert.equal(row.state, "available");
});
