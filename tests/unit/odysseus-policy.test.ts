import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOdysseusPolicy,
  parseOdysseusMetadata,
  type OdysseusRouteApproval,
} from "../../src/lib/odysseus/policy.ts";
import { createOdysseusTelemetry, withOdysseusUsage } from "../../src/lib/odysseus/telemetry.ts";
import { enforceOdysseusPolicy } from "../../src/lib/odysseus/routeGuard.ts";

const base = {
  provider: "test-provider",
  model: "test-model",
  enabled: true,
  approvalStatus: "approved" as const,
  pricing: "free_api_tier" as const,
  privateSourceApproved: false,
  dataRetention: "unknown" as const,
  trainingOnInput: "unknown" as const,
  riskCategory: "unknown" as const,
};
const approvals: OdysseusRouteApproval[] = [
  { ...base, role: "scout" },
  { ...base, model: "coder-model", role: "coder" },
  { ...base, model: "paid-model", role: "scout", pricing: "paid" },
  { ...base, model: "unknown-price", role: "scout", pricing: "unknown" },
];

function headers(overrides: Record<string, string> = {}) {
  return new Headers({
    "x-odysseus-task-id": "task-1",
    "x-odysseus-role": "scout",
    "x-odysseus-privacy-class": "public",
    "x-odysseus-free-only": "true",
    "x-odysseus-allowed-routes": "test-provider/test-model",
    "x-odysseus-policy-version": "2026-09-05",
    ...overrides,
  });
}

test("disabled metadata preserves normal behavior", () => {
  const parsed = parseOdysseusMetadata(new Headers());
  assert.equal(evaluateOdysseusPolicy(parsed, approvals).result, "disabled");
});

test("parses structured extension and headers", () => {
  const parsed = parseOdysseusMetadata(new Headers(), {
    odysseus_policy: {
      task_id: "task-2",
      role: "coder",
      privacy_class: "public",
      free_only: true,
      allowed_routes: ["test-provider/coder-model"],
      policy_version: "v1",
    },
  });
  assert.equal("metadata" in parsed && parsed.metadata.role, "coder");
});

test("unknown role and privacy class fail closed", () => {
  assert.equal(
    evaluateOdysseusPolicy(
      parseOdysseusMetadata(headers({ "x-odysseus-role": "admin" })),
      approvals
    ).reason,
    "UNKNOWN_ROLE"
  );
  assert.equal(
    evaluateOdysseusPolicy(
      parseOdysseusMetadata(headers({ "x-odysseus-privacy-class": "secret" })),
      approvals
    ).reason,
    "UNKNOWN_PRIVACY_CLASS"
  );
});

test("sensitive and default private_source are denied", () => {
  assert.equal(
    evaluateOdysseusPolicy(
      parseOdysseusMetadata(headers({ "x-odysseus-privacy-class": "sensitive" })),
      approvals
    ).reason,
    "PRIVACY_DENIED"
  );
  assert.equal(
    evaluateOdysseusPolicy(
      parseOdysseusMetadata(headers({ "x-odysseus-privacy-class": "private_source" })),
      approvals
    ).reason,
    "PRIVACY_DENIED"
  );
});

test("approved public route succeeds with exact provider/model attribution", () => {
  const decision = evaluateOdysseusPolicy(
    parseOdysseusMetadata(headers()),
    approvals,
    "test-provider/test-model"
  );
  assert.equal(decision.result, "allowed");
  assert.equal(decision.selectedRoute?.provider, "test-provider");
  assert.equal(decision.selectedRoute?.model, "test-model");
});

test("role approval does not cross from scout to coder", () => {
  const decision = evaluateOdysseusPolicy(
    parseOdysseusMetadata(headers({ "x-odysseus-role": "coder" })),
    approvals,
    "test-provider/test-model"
  );
  assert.equal(decision.reason, "NO_APPROVED_FREE_ROUTE");
});

test("free-only excludes paid, unknown pricing, and exhausted quota", () => {
  const paid = evaluateOdysseusPolicy(
    parseOdysseusMetadata(headers({ "x-odysseus-allowed-routes": "test-provider/paid-model" })),
    approvals,
    "test-provider/paid-model"
  );
  assert.equal(paid.reason, "NO_APPROVED_FREE_ROUTE");
  const unknown = evaluateOdysseusPolicy(
    parseOdysseusMetadata(headers({ "x-odysseus-allowed-routes": "test-provider/unknown-price" })),
    approvals,
    "test-provider/unknown-price"
  );
  assert.equal(unknown.reason, "NO_APPROVED_FREE_ROUTE");
  const exhausted = evaluateOdysseusPolicy(
    parseOdysseusMetadata(headers()),
    [{ ...base, role: "scout", quotaAvailable: false }],
    "test-provider/test-model"
  );
  assert.equal(exhausted.reason, "FREE_QUOTA_EXHAUSTED");
  const unavailable = evaluateOdysseusPolicy(
    parseOdysseusMetadata(headers()),
    [{ ...base, role: "scout", providerAvailable: false }],
    "test-provider/test-model"
  );
  assert.equal(unavailable.reason, "PROVIDER_UNAVAILABLE");
});

test("telemetry keeps unavailable usage null and measured/estimated labels distinct", () => {
  const decision = evaluateOdysseusPolicy(parseOdysseusMetadata(headers()), approvals);
  const telemetry = createOdysseusTelemetry(decision, "req-1", "test-provider/test-model");
  assert.equal(telemetry.input_tokens, null);
  assert.equal(telemetry.output_tokens, null);
  assert.equal(telemetry.usage_source, "unavailable");
  assert.equal(telemetry.actual_model, "test-model");
  assert.equal(telemetry.provider, "test-provider");
  const measured = withOdysseusUsage(telemetry, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
    usage_source: "measured",
  });
  assert.equal(measured.input_tokens, 10);
  assert.equal(measured.cached_input_tokens, null);
  assert.equal(measured.usage_source, "measured");
  assert.equal(
    withOdysseusUsage(telemetry, { output_tokens: 4, usage_source: "estimated" }).usage_source,
    "estimated"
  );
});

test("sensitive requests are rejected before a provider adapter can be invoked", async () => {
  let providerCalls = 0;
  const result = enforceOdysseusPolicy(headers({ "x-odysseus-privacy-class": "sensitive" }), {
    model: "test-provider/test-model",
    messages: [{ role: "user", content: "secret" }],
  });
  if (!result.response) providerCalls += 1;
  assert.equal(result.response?.status, 403);
  assert.equal(providerCalls, 0);
  assert.match(await result.response!.text(), /PRIVACY_DENIED/);
});

test("malformed policy is a deterministic machine-readable denial", async () => {
  const result = enforceOdysseusPolicy(new Headers({ "x-odysseus-role": "scout" }), {
    model: "test-provider/test-model",
  });
  assert.equal(result.response?.status, 403);
  const body = JSON.parse(await result.response!.text()) as { error: { code: string } };
  assert.equal(body.error.code, "MALFORMED_POLICY");
});
