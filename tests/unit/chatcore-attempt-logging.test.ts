// tests/unit/chatcore-attempt-logging.test.ts
// Characterization of persistAttemptLogs — the per-attempt call-log persistence extracted from
// handleChatCore (chatCore god-file decomposition, #3501). Uses a real temp DB and polls the
// persisted row (saveCallLog is async + fire-and-forget). Locks: the field mapping, the
// cacheSource semantic/upstream normalization, final credentials.connectionId attribution,
// credentials fallback, and error persistence.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-attempt-logging-test-"));
process.env.DATA_DIR = testDataDir;

const coreDb = await import("../../src/lib/db/core.ts");
const { getCallLogById, updateCallLogAccounting } = await import("../../src/lib/usage/callLogs.ts");
const callLogDetailRoute = await import("../../src/app/api/usage/call-logs/[id]/route.ts");
const { attributeExecutionAttemptAccounting, persistAttemptLogs } =
  await import("../../open-sse/handlers/chatCore/attemptLogging.ts");
const { getAuditLog } = await import("../../src/lib/compliance/index.ts");

type CodexRotationEnvelope = {
  _omniroute?: {
    codexAccountRotation?: {
      initialConnectionId: unknown;
      finalConnectionId: unknown;
    };
  };
};

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    connectionId: "conn-1",
    model: "gpt-x",
    skillRequestId: "skill-1",
    detailedLoggingEnabled: false,
    reqLogger: null,
    pendingRequestId: "REPLACE",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    requestedModel: "gpt-x-requested",
    credentials: { connectionId: "cred-conn" },
    startTime: Date.now(),
    body: { messages: [{ role: "user", content: "hi" }] },
    sourceFormat: "openai",
    targetFormat: "openai",
    comboName: null,
    comboStepId: null,
    comboExecutionKey: null,
    tokensCompressed: 0,
    apiKeyInfo: { id: "key-1", name: "Key One" },
    noLogEnabled: false,
    ...overrides,
  } as Parameters<typeof persistAttemptLogs>[1];
}

async function pollForCallLog(id: string, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const row = await getCallLogById(id);
    if (row) return row as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function getCodexAccountRotation(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  return (value as CodexRotationEnvelope)._omniroute?.codexAccountRotation;
}

before(async () => {
  await coreDb.ensureDbInitialized();
});

after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("persists a call log row with the mapped fields (default cacheSource=upstream)", async () => {
  const id = "attempt-basic-1";
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 } },
    baseCtx({ pendingRequestId: id, credentials: { connectionId: "conn-1" } })
  );
  const row = await pollForCallLog(id);
  assert.ok(row, "call log row should be persisted");
  assert.equal(row.status, 200);
  assert.equal(row.model, "gpt-x");
  assert.equal(row.provider, "openai");
  assert.equal(row.requestedModel, "gpt-x-requested");
  assert.equal(row.connectionId, "conn-1");
  assert.equal(row.cacheSource, "upstream");
});

test("late OpenRouter generation metadata enriches the saved accounting receipt", async () => {
  const id = "attempt-openrouter-generation-enrichment";
  const initialAccounting = {
    kind: "estimated_cost",
    amountUsd: 0.25,
    currency: "USD",
    source: "models_dev.api_json",
    pricingProvider: "openrouter",
    pricingModel: "vendor/model",
    pricingVersion: null,
    pricingEffectiveAt: null,
    pricingRetrievedAt: null,
    pricingStale: null,
    usageKind: "provider_reported_usage",
  } as const;
  await persistAttemptLogs(
    { status: 200, accounting: initialAccounting },
    baseCtx({ pendingRequestId: id })
  );

  const enrichedAccounting = {
    ...initialAccounting,
    kind: "provider_reported_billed_cost",
    amountUsd: 0.0002,
    amountUsdExact: "0.0002",
    source: "openrouter.generation_api.total_cost",
    downstreamProvider: "Host A",
    providerRequestId: "gen-123",
    providerReceipts: [
      {
        id: "gen-123",
        source: "openrouter.generation_api",
        retrievedAt: "2026-10-13T00:00:00.000Z",
        model: "vendor/model",
        providerName: "Host A",
        upstreamId: "upstream-1",
        promptTokens: 12,
        completionTokens: 7,
        totalCostUsd: 0.0002,
        isByok: false,
      },
    ],
  } as const;
  updateCallLogAccounting(id, enrichedAccounting);

  const row = await getCallLogById(id);
  assert.ok(row);
  const stored = row.accounting as typeof enrichedAccounting;
  assert.equal(stored.kind, "provider_reported_billed_cost");
  assert.equal(stored.downstreamProvider, "Host A");
  assert.equal(stored.providerReceipts[0]?.id, "gen-123");
  assert.equal(stored.amountUsdExact, "0.0002");

  const detailResponse = await callLogDetailRoute.GET(
    new Request(`http://localhost/api/usage/call-logs/${id}`),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as {
    accounting?: { downstreamProvider?: string; providerReceipts?: Array<{ id?: string }> };
  };
  assert.equal(detail.accounting?.downstreamProvider, "Host A");
  assert.equal(detail.accounting?.providerReceipts?.[0]?.id, "gen-123");
});

test("attributes usage and cost only to the final successful upstream attempt", () => {
  const attempts = [
    { index: 1, statusCode: 429, outcome: "response", costAttribution: "unknown" },
    { index: 2, statusCode: 200, outcome: "response", costAttribution: "unknown" },
  ];
  const accounting = {
    kind: "provider_reported_billed_cost",
    amountUsd: 0.0012,
    currency: "USD",
    source: "openrouter_response.usage.cost",
    pricingProvider: "openrouter",
    pricingModel: "vendor/model:free",
    pricingVersion: null,
    pricingEffectiveAt: null,
    pricingRetrievedAt: null,
    pricingStale: null,
    pricingCondition: null,
    usageKind: "provider_reported_usage",
  } as const;

  const attributed = attributeExecutionAttemptAccounting(
    attempts,
    { prompt_tokens: 12, completion_tokens: 8, estimated: false, body_bytes: 2048 },
    accounting
  );

  assert.equal(attributed[0]?.costAttribution, "unknown");
  assert.equal("usage" in (attributed[0] ?? {}), false);
  assert.equal(attributed[1]?.costAttribution, "provider_reported");
  assert.deepEqual(attributed[1]?.usage, {
    kind: "provider_reported_usage",
    dimensions: { prompt_tokens: 12, completion_tokens: 8 },
  });
  assert.equal((attributed[1]?.accounting as { amountUsd: number }).amountUsd, 0.0012);
  assert.equal("accounting" in (attempts[1] ?? {}), false, "source attempts are not mutated");
});

test("persists per-attempt usage and accounting in the compact execution receipt", async () => {
  const id = "attempt-accounting-receipt-1";
  persistAttemptLogs(
    {
      status: 200,
      tokens: { prompt_tokens: 12, completion_tokens: 8 },
      accounting: {
        kind: "estimated_cost",
        amountUsd: 0.0004,
        currency: "USD",
        source: "models_dev.api_json",
        pricingProvider: "openai",
        pricingModel: "gpt-x",
        pricingVersion: null,
        pricingEffectiveAt: null,
        pricingRetrievedAt: "2026-10-12T10:00:00.000Z",
        pricingStale: false,
        pricingCondition: null,
        usageKind: "provider_reported_usage",
      },
    },
    baseCtx({
      pendingRequestId: id,
      getExecutionAttempts: () => [
        { index: 1, statusCode: 429, outcome: "response", costAttribution: "unknown" },
        { index: 2, statusCode: 200, outcome: "response", costAttribution: "unknown" },
      ],
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  const pipelinePayloads = row.pipelinePayloads as { executionAttempts?: unknown[] } | null;
  assert.deepEqual(pipelinePayloads?.executionAttempts, [
    { index: 1, statusCode: 429, outcome: "response", costAttribution: "unknown" },
    {
      index: 2,
      statusCode: 200,
      outcome: "response",
      costAttribution: "estimated",
      usage: {
        kind: "provider_reported_usage",
        dimensions: { prompt_tokens: 12, completion_tokens: 8 },
      },
      accounting: {
        kind: "estimated_cost",
        amountUsd: 0.0004,
        currency: "USD",
        source: "models_dev.api_json",
        pricingProvider: "openai",
        pricingModel: "gpt-x",
        pricingVersion: null,
        pricingEffectiveAt: null,
        pricingRetrievedAt: "2026-10-12T10:00:00.000Z",
        pricingStale: false,
        pricingCondition: null,
        usageKind: "provider_reported_usage",
      },
    },
  ]);

  const detailResponse = await callLogDetailRoute.GET(
    new Request(`http://localhost/api/usage/call-logs/${id}`),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as {
    id: string;
    pipelinePayloads?: { executionAttempts?: Array<Record<string, unknown>> };
  };
  assert.equal(detail.id, id);
  assert.equal(detail.pipelinePayloads?.executionAttempts?.length, 2);
  assert.equal(
    (detail.pipelinePayloads?.executionAttempts?.[1]?.accounting as { source?: string })?.source,
    "models_dev.api_json"
  );
});

test("compact execution receipts do not enable provider payload capture", async () => {
  const id = "attempt-accounting-no-payload-capture";
  persistAttemptLogs(
    {
      status: 200,
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      providerRequest: { body: { messages: [{ role: "user", content: "secret prompt" }] } },
      providerResponse: { body: { choices: [{ message: { content: "private response" } }] } },
      clientResponse: { body: { choices: [{ message: { content: "private response" } }] } },
    },
    baseCtx({
      pendingRequestId: id,
      getExecutionAttempts: () => [{ index: 1, statusCode: 200, outcome: "response" }],
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  const pipelinePayloads = row.pipelinePayloads as Record<string, unknown>;
  assert.deepEqual(pipelinePayloads.executionAttempts, [
    { index: 1, statusCode: 200, outcome: "response" },
  ]);
  assert.equal("providerRequest" in pipelinePayloads, false);
  assert.equal("providerResponse" in pipelinePayloads, false);
  assert.equal("clientResponse" in pipelinePayloads, false);
});

test("execution receipts whitelist fields before persistence", async () => {
  const id = "attempt-receipt-whitelist";
  persistAttemptLogs(
    { status: 200 },
    baseCtx({
      pendingRequestId: id,
      getExecutionAttempts: () => [
        {
          index: 1,
          statusCode: 200,
          outcome: "response",
          routeModel: "vendor/model",
          providerRequestId: "request-1",
          url: "https://provider.example/path?api_key=secret",
          headers: { authorization: "Bearer secret" },
          requestBody: { messages: [{ content: "private prompt" }] },
          apiKey: "secret",
          unknownFuturePayload: "must not be persisted",
        },
      ],
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  const pipelinePayloads = row.pipelinePayloads as {
    executionAttempts?: Array<Record<string, unknown>>;
  };
  assert.deepEqual(pipelinePayloads.executionAttempts, [
    {
      index: 1,
      statusCode: 200,
      outcome: "response",
      routeModel: "vendor/model",
      providerRequestId: "request-1",
    },
  ]);
  assert.equal(JSON.stringify(pipelinePayloads.executionAttempts).includes("secret"), false);
  assert.equal(
    JSON.stringify(pipelinePayloads.executionAttempts).includes("private prompt"),
    false
  );
});

test("persists exact provider-reported USD ticks in the public call-log receipt", async () => {
  const id = "attempt-accounting-exact-usd-ticks";
  persistAttemptLogs(
    {
      status: 200,
      tokens: { prompt_tokens: 1, completion_tokens: 1, cost_in_usd_ticks: 37_756_000 },
      accounting: {
        kind: "provider_reported_billed_cost",
        amountUsd: 0.0037756,
        amountUsdExact: "0.0037756",
        currency: "USD",
        source: "provider_usage.cost_in_usd_ticks",
        pricingProvider: "xai",
        pricingModel: "grok-model",
        pricingVersion: null,
        pricingEffectiveAt: null,
        pricingRetrievedAt: null,
        pricingStale: null,
        pricingCondition: null,
        providerReceiptsComplete: false,
        providerReceiptsTruncated: true,
        usageKind: "provider_reported_usage",
      },
    },
    baseCtx({
      pendingRequestId: id,
      getExecutionAttempts: () => [
        { index: 1, statusCode: 200, outcome: "response", costAttribution: "unknown" },
      ],
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  const detailResponse = await callLogDetailRoute.GET(
    new Request(`http://localhost/api/usage/call-logs/${id}`),
    { params: Promise.resolve({ id }) }
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as {
    accounting?: { providerReceiptsComplete?: boolean; providerReceiptsTruncated?: boolean };
    pipelinePayloads?: { executionAttempts?: Array<Record<string, unknown>> };
  };
  assert.equal(detail.accounting?.providerReceiptsComplete, false);
  assert.equal(detail.accounting?.providerReceiptsTruncated, true);
  const receipt = detail.pipelinePayloads?.executionAttempts?.[0];
  assert.equal((receipt?.accounting as { amountUsdExact?: string })?.amountUsdExact, "0.0037756");
});

test("uses final credentials connectionId when Codex failover rotates the account", async () => {
  const id = "attempt-codex-rotation-1";
  persistAttemptLogs(
    { status: 200, tokens: { input: 1, output: 2 }, responseBody: { id: "response-1" } },
    baseCtx({
      pendingRequestId: id,
      provider: "codex",
      connectionId: "initial-conn",
      credentials: { connectionId: "final-conn" },
    })
  );

  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.connectionId, "final-conn");
  assert.deepEqual(getCodexAccountRotation(row.requestBody), {
    initialConnectionId: "initial-conn",
    finalConnectionId: "final-conn",
  });
  assert.deepEqual(getCodexAccountRotation(row.responseBody), {
    initialConnectionId: "initial-conn",
    finalConnectionId: "final-conn",
  });
});

test("cacheSource 'semantic' is preserved", async () => {
  const id = "attempt-semantic-1";
  persistAttemptLogs({ status: 200, cacheSource: "semantic" }, baseCtx({ pendingRequestId: id }));
  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.cacheSource, "semantic");
});

test("connectionId falls back to credentials.connectionId when null, and error is persisted", async () => {
  const id = "attempt-fallback-1";
  persistAttemptLogs(
    { status: 502, error: "upstream boom" },
    baseCtx({ pendingRequestId: id, connectionId: null })
  );
  const row = await pollForCallLog(id);
  assert.ok(row);
  assert.equal(row.connectionId, "cred-conn");
  assert.equal(row.status, 502);
  assert.match(String(row.error ?? ""), /upstream boom/);
});

function duplicateHeartbeatBody() {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: "heartbeat_respond", arguments: "{}" } },
            { function: { name: "heartbeat_respond", arguments: "{}" } },
          ],
        },
      },
    ],
  };
}

test("duplicate tool_calls in the assembled body writes provider.spec_violation audit", () => {
  persistAttemptLogs(
    { status: 200, responseBody: duplicateHeartbeatBody() },
    baseCtx({ pendingRequestId: "attempt-spec-violation-1", skillRequestId: "skill-spec-1" })
  );
  // logAuditEvent is synchronous; do not wait on the fire-and-forget saveCallLog.
  const rows = getAuditLog({ action: "provider.spec_violation", requestId: "skill-spec-1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.resourceType, "provider_spec_violation");
  const details = rows[0]?.details;
  assert.ok(details && typeof details === "object");
  assert.equal(
    (details as { violation?: string }).violation,
    'duplicate tool_calls entry for "heartbeat_respond"'
  );
});

test("unique tool_calls do not write provider.spec_violation audit", () => {
  persistAttemptLogs(
    {
      status: 200,
      responseBody: {
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "heartbeat_respond", arguments: "{}" } },
                { function: { name: "other_tool", arguments: "{}" } },
              ],
            },
          },
        ],
      },
    },
    baseCtx({ pendingRequestId: "attempt-spec-clean-1", skillRequestId: "skill-spec-clean-1" })
  );
  const rows = getAuditLog({
    action: "provider.spec_violation",
    requestId: "skill-spec-clean-1",
  });
  assert.equal(rows.length, 0);
});
