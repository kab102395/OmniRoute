/**
 * TDD regression for #5239: an upstream HTTP 402 "Insufficient account balance"
 * must disable the depleted key on an API Key Round-Robin connection.
 *
 * Bug: `recordKeyHealthStatus()` only recorded a per-key failure for status 401.
 * Every other status (including 402) was ignored, so when multiple keys live on
 * ONE connection via `providerSpecificData.extraApiKeys`, a 402 on the selected
 * key never marked it invalid — the rotator kept returning the depleted key.
 *
 * Fix: a 402 branch marks the current key invalid immediately (terminal — the
 * balance won't recover mid-session), so `getValidApiKey()` skips it and the
 * rotator falls through to the remaining key. This test fails before the fix
 * (the 402'd key stays "active" and is still returned) and passes after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-5239-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { recordKeyHealthStatus } = await import("../../open-sse/handlers/chatCore/keyHealth.ts");
const { getValidApiKey, getAllKeyHealth, resetKeyStatus, shouldDisableConnectionForQuotaFailure } =
  await import("../../open-sse/services/apiKeyRotator.ts");
const { shouldRecordStreamingKeyHealthStatus } =
  await import("../../open-sse/handlers/chatCore/keyHealth.ts");
const { shouldSkipConnDisable } = await import("../../open-sse/services/combo/comboPredicates.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Two keys live on ONE connection as API Key Round-Robin (extraApiKeys[]).
// No primary key, so the rotator only chooses among the two extras — making the
// "skips invalid, returns the other" assertion deterministic.
const K1 = "sk-depleted-402";
const K2 = "sk-healthy-key";

function buildCreds(connId: string, selectedKeyId: string) {
  return {
    connectionId: connId,
    apiKey: selectedKeyId === "extra_0" ? K1 : K2,
    providerSpecificData: {
      extraApiKeys: [K1, K2],
      selectedKeyId,
      apiKeyHealth: {},
    },
  } as Record<string, unknown>;
}

test("#5239 402 marks the selected round-robin key invalid and the rotator skips it", () => {
  const connId = "conn-5239-402";
  // Selected key is extra_0 (K1) — the one upstream rejected with 402.
  recordKeyHealthStatus(402, buildCreds(connId, "extra_0"));

  // The 402'd key is now invalid in the in-memory rotator state.
  const allHealth = getAllKeyHealth();
  assert.equal(
    allHealth[`${connId}:extra_0`]?.status,
    "invalid",
    "402 must mark the selected key invalid in one shot"
  );
  assert.equal(
    getAllKeyHealth()[`${connId}:extra_1`]?.status,
    undefined,
    "a 402 on one slot must not terminalize its sibling"
  );
  assert.equal(
    shouldDisableConnectionForQuotaFailure(connId, [K2]),
    false,
    "multi-key connection must stay active when one slot exhausts"
  );

  // The rotator must skip the depleted extra_0 (K1) and return extra_1 (K2).
  for (let i = 0; i < 4; i++) {
    const next = getValidApiKey(connId, "", [K1, K2]);
    assert.ok(next, "a valid key should remain");
    assert.notEqual(next!.key, K1, "depleted 402 key must never be returned");
    assert.equal(next!.key, K2, "rotator should fall through to the healthy key");
  }

  resetKeyStatus(connId, "extra_0");
  resetKeyStatus(connId, "extra_1");
});

test("single-key quota failures may still terminalize the connection", () => {
  assert.equal(shouldDisableConnectionForQuotaFailure("single-key-402", []), true);
});

test("a pinned primary 402 invalidates only primary on a shared-key connection", () => {
  const connId = "conn-5239-primary";
  recordKeyHealthStatus(402, {
    connectionId: connId,
    apiKey: "primary-key",
    providerSpecificData: {
      selectedKeyId: "primary",
      extraApiKeys: ["extra-key"],
      apiKeyHealth: {},
    },
  });

  const health = getAllKeyHealth();
  assert.equal(health[`${connId}:primary`]?.status, "invalid");
  assert.notEqual(health[`${connId}:extra_0`]?.status, "invalid");
  assert.equal(shouldDisableConnectionForQuotaFailure(connId, ["extra-key"]), false);
  resetKeyStatus(connId, "primary");
  resetKeyStatus(connId, "extra_0");
});

test("streaming 402 responses are recorded against their selected key slot", () => {
  assert.equal(shouldRecordStreamingKeyHealthStatus(402), true);
  assert.equal(shouldRecordStreamingKeyHealthStatus(200), true);
  assert.equal(shouldRecordStreamingKeyHealthStatus(401), true);
  assert.equal(shouldRecordStreamingKeyHealthStatus(403), true);
  assert.equal(shouldRecordStreamingKeyHealthStatus(500), false);
});

test("a 402 with sibling key slots never reaches connection-level disable (state 1: primary exhausted / extra healthy)", () => {
  const connId = "conn-5239-outer-primary";
  // The selected slot terminalizes in-memory only (as the streaming path records it).
  recordKeyHealthStatus(402, buildCreds(connId, "primary"));
  assert.equal(getAllKeyHealth()[`${connId}:primary`]?.status, "invalid");
  assert.equal(getAllKeyHealth()[`${connId}:extra_0`]?.status, undefined);

  // The OUTER connection cooldown layer must agree: skip markAccountUnavailable so
  // testStatus=credits_exhausted is never persisted over healthy sibling slots.
  assert.equal(
    shouldSkipConnDisable({ status: 402 }, false, true, "mistral"),
    true,
    "sibling slots exist — the outer path must not disable the shared connection"
  );
  // The inner quota branch agrees (connection stays active when extras exist).
  assert.equal(shouldDisableConnectionForQuotaFailure(connId, ["sk-extra"]), false);
  resetKeyStatus(connId, "primary");
  resetKeyStatus(connId, "extra_0");
});

test("a 402 on extra_0 keeps the shared connection routable (state 2: extra exhausted / primary healthy)", () => {
  const connId = "conn-5239-outer-extra";
  recordKeyHealthStatus(402, buildCreds(connId, "extra_0"));
  assert.equal(getAllKeyHealth()[`${connId}:extra_0`]?.status, "invalid");
  assert.notEqual(getAllKeyHealth()[`${connId}:primary`]?.status, "invalid");

  assert.equal(shouldSkipConnDisable({ status: 402 }, false, true, "mistral"), true);
  assert.equal(shouldDisableConnectionForQuotaFailure(connId, [K2]), false);
  resetKeyStatus(connId, "primary");
  resetKeyStatus(connId, "extra_0");
});

test("a single-key 402 still disables the connection at both layers (no sibling slots)", () => {
  // Outer: no extra keys → the connection-wide credits_exhausted state is correct.
  assert.equal(shouldSkipConnDisable({ status: 402 }, false, false, "mistral"), false);
  // Inner: no extra keys → connection-terminal (unchanged from 3a1cb03).
  assert.equal(shouldDisableConnectionForQuotaFailure("conn-5239-single", []), true);
});

test("#5239 inverse: a 2xx keeps the key active (no false-positive disable)", () => {
  const connId = "conn-5239-2xx";
  recordKeyHealthStatus(200, buildCreds(connId, "extra_0"));

  const allHealth = getAllKeyHealth();
  const entry = allHealth[`${connId}:extra_0`];
  // active (or absent — never invalidated) on success.
  assert.notEqual(entry?.status, "invalid", "a 2xx must not disable the key");

  // Both keys remain selectable.
  const selected = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const next = getValidApiKey(connId, "", [K1, K2]);
    if (next) selected.add(next.key);
  }
  assert.ok(selected.has(K1), "K1 must remain usable after a 2xx");
  assert.ok(selected.has(K2), "K2 must remain usable");

  resetKeyStatus(connId, "extra_0");
  resetKeyStatus(connId, "extra_1");
});
