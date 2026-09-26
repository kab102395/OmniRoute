import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-freebuff-observations-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const snapshotsDb = await import("../../src/lib/db/quotaSnapshots.ts");
const { persistFreebuffResourceObservation } =
  await import("../../src/domain/freebuffObservations.ts");
const quotaCache = await import("../../src/domain/quotaCache.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Freebuff session observations persist authoritative balances and separate derived values", () => {
  persistFreebuffResourceObservation({
    connectionId: "connection-1",
    observedAt: Date.parse("2026-09-25T10:00:00.000Z"),
    response: {
      status: "active",
      instanceId: "private-instance-id",
      model: "deepseek/deepseek-v4-flash",
      admittedAt: "2026-09-25T09:00:00.000Z",
      expiresAt: "2026-09-25T10:30:00.000Z",
      remainingMs: 1_800_000,
      freebucks: {
        balance: 0,
        quotaExempt: false,
        daily: {
          limit: 10,
          spent: 10,
          remaining: 0,
          resetAt: "2026-09-26T07:00:00.000Z",
          resetTimeZone: "America/Los_Angeles",
        },
        wallet: { balance: 0, monthlyBonus: 0, nextBonusAt: null },
        prices: { "deepseek/deepseek-v4-flash": 3 },
      },
    },
  });

  const rows = snapshotsDb.getQuotaSnapshots({
    provider: "freebuff",
    connectionId: "connection-1",
    since: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].windowKey, "freebuff:resource:session");
  assert.equal(rows[0].remainingPercentage, 0);
  assert.equal(rows[0].isExhausted, 1);
  const raw = JSON.parse(String(rows[0].rawData)) as {
    provenance: string;
    freebucks: {
      balance: number;
      daily: {
        limit: number;
        remaining: number;
        percent_remaining: number;
        percent_remaining_provenance: string;
      };
      wallet: { balance: number };
      prices: Record<string, number>;
    };
    session: {
      observed_remaining_ms: number;
      remaining_session_ms: number;
      remaining_session_ms_provenance: string;
      instance_ref: string;
    };
  };
  assert.equal(raw.provenance, "OBSERVED_UPSTREAM");
  assert.equal(raw.freebucks.balance, 0);
  assert.equal(raw.freebucks.daily.limit, 10);
  assert.equal(raw.freebucks.daily.remaining, 0);
  assert.equal(raw.freebucks.daily.percent_remaining, 0);
  assert.equal(raw.freebucks.daily.percent_remaining_provenance, "DERIVED");
  assert.equal(raw.freebucks.wallet.balance, 0);
  assert.equal(raw.freebucks.prices["deepseek/deepseek-v4-flash"], 3);
  assert.equal(raw.session.observed_remaining_ms, 1_800_000);
  assert.equal(raw.session.remaining_session_ms, 1_800_000);
  assert.equal(raw.session.remaining_session_ms_provenance, "DERIVED");
  assert.notEqual(raw.session.instance_ref, "private-instance-id");
  assert.doesNotMatch(String(rows[0].rawData), /private-instance-id|Bearer|test-token/);
  assert.equal(quotaCache.getQuotaCache("connection-1"), null);
  assert.equal(quotaCache.isAccountQuotaExhausted("connection-1"), false);
});

test("Freebuff snapshot does not invent a percentage without a positive daily limit", () => {
  persistFreebuffResourceObservation({
    connectionId: "connection-2",
    response: {
      status: "none",
      freebucks: {
        balance: 7,
        daily: { limit: 0, spent: 0, remaining: 0, resetAt: "2026-09-26T07:00:00Z" },
        wallet: { balance: 7, monthlyBonus: 0 },
        prices: { "deepseek/deepseek-v4-flash": 3 },
      },
    },
  });
  const rows = snapshotsDb.getQuotaSnapshots({
    provider: "freebuff",
    connectionId: "connection-2",
    since: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remainingPercentage, null);
  const raw = JSON.parse(String(rows[0].rawData)) as {
    freebucks: {
      balance: number;
      daily: { percent_remaining: number | null };
      capacity_by_model: Record<string, string>;
      capacity_by_model_provenance: string;
    };
  };
  assert.equal(raw.freebucks.balance, 7);
  assert.equal(raw.freebucks.daily.percent_remaining, null);
  assert.equal(raw.freebucks.capacity_by_model["deepseek/deepseek-v4-flash"], "consent_required");
  assert.equal(raw.freebucks.capacity_by_model_provenance, "DERIVED");
});
