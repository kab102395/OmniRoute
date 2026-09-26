import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFreebuffAdmissionHeaders,
  classifyFreebuffAdmission,
  deriveRemainingSessionMs,
  isFreebuffActiveAdmission,
  stableFreebuffInstanceRef,
} from "../../open-sse/executors/freebuffProtocol.ts";

test("Freebuff single-session admission sends only protocol-safe defaults", () => {
  const headers = buildFreebuffAdmissionHeaders("test-token", "deepseek/deepseek-v4-flash");
  assert.equal(headers.get("authorization"), "Bearer test-token");
  assert.equal(headers.get("x-freebuff-model"), "deepseek/deepseek-v4-flash");
  assert.equal(headers.get("x-freebuff-first-tab-discount"), "0");
  assert.equal(headers.get("x-freebuff-wallet-spend-limit"), "0");
  for (const desktopHeader of [
    "x-freebuff-multi-session",
    "x-freebuff-purchase-continuity",
    "x-freebuff-desktop-attempt-id",
    "x-freebuff-takeover-instance-id",
    "x-freebuff-instance-id",
  ]) {
    assert.equal(headers.has(desktopHeader), false, `${desktopHeader} must remain absent`);
  }
  assert.equal(
    headers.has("x-fb-timezone"),
    false,
    "server timezone must not impersonate the caller"
  );
});

test("Freebuff admission response statuses map to safe classifications", () => {
  const cases: Array<[string, number, string]> = [
    ["active", 200, "ADMITTED"],
    ["rate_limited", 429, "NO_CAPACITY"],
    ["spend_limited", 403, "NO_CAPACITY"],
    ["ip_capped", 429, "NO_CAPACITY"],
    ["purchase_capacity", 409, "NO_CAPACITY"],
    ["premium_slot_taken", 409, "NO_CAPACITY"],
    ["banned", 403, "ACCOUNT_RESTRICTED"],
    ["country_blocked", 403, "ACCOUNT_RESTRICTED"],
    ["model_unavailable", 409, "MODEL_RESTRICTED"],
    ["consent_required", 409, "CONSENT_REQUIRED"],
    ["model_locked", 409, "SESSION_CONFLICT"],
    ["ended", 409, "SESSION_CONFLICT"],
    ["superseded", 409, "SESSION_CONFLICT"],
    ["purchase_in_use", 409, "SESSION_CONFLICT"],
    ["purchase_claim_released", 409, "SESSION_CONFLICT"],
    ["first_tab_discount_changed", 409, "UNKNOWN"],
    ["none", 200, "UNKNOWN"],
  ];
  for (const [state, httpStatus, expected] of cases) {
    assert.equal(classifyFreebuffAdmission(state, httpStatus), expected, state);
  }
  assert.equal(classifyFreebuffAdmission(null, 503), "TRANSIENT_PROVIDER_FAILURE");
  assert.equal(classifyFreebuffAdmission("unrecognized", 200), "UNKNOWN");
});

test("active Freebuff sessions expose safe identity and derived timer semantics", () => {
  assert.equal(isFreebuffActiveAdmission({ status: "active", instanceId: "opaque" }), true);
  assert.equal(isFreebuffActiveAdmission({ status: "active", instanceId: "" }), false);
  assert.equal(isFreebuffActiveAdmission({ status: "none" }), false);
  assert.equal(
    deriveRemainingSessionMs("2026-01-01T00:00:10.000Z", Date.parse("2026-01-01T00:00:00Z")),
    10_000
  );
  assert.equal(
    deriveRemainingSessionMs("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:10Z")),
    0
  );
  assert.equal(deriveRemainingSessionMs("not-a-timestamp", Date.now()), null);
  assert.equal(deriveRemainingSessionMs(undefined, Date.now()), null);
  assert.equal(stableFreebuffInstanceRef("opaque"), stableFreebuffInstanceRef("opaque"));
  assert.notEqual(stableFreebuffInstanceRef("opaque"), "opaque");
});
