import assert from "node:assert/strict";
import test from "node:test";

import { executeQuotaManagement } from "../../src/lib/a2a/skills/quotaManagement.ts";
import type { A2ATask } from "../../src/lib/a2a/taskManager.ts";

const originalFetch = globalThis.fetch;

function makeTask(query: string): A2ATask {
  return {
    input: { messages: [{ content: query }] },
  } as unknown as A2ATask;
}

function installQuotaResponses() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/usage/quota")) {
      return Response.json({
        providers: [
          {
            provider: "unknown-account",
            connectionId: "unknown-1",
            quotaUsed: 0,
            quotaTotal: null,
            percentRemaining: 100,
            quotaSource: "unknown",
            quotaRetrievedAt: null,
            resetAt: null,
            tokenStatus: "valid",
            connectionStatus: "unknown",
          },
          {
            provider: "measured-account",
            connectionId: "known-1",
            quotaUsed: 75,
            quotaTotal: 100,
            percentRemaining: 25,
            quotaSource: "learned_limit",
            quotaRetrievedAt: "2026-10-13T00:00:00.000Z",
            resetAt: null,
            tokenStatus: "valid",
            connectionStatus: "available",
          },
        ],
      });
    }
    return Response.json({ combos: [] });
  }) as typeof fetch;
}

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("A2A quota ranking labels unknown capacity as unknown instead of unlimited", async () => {
  installQuotaResponses();
  const result = await executeQuotaManagement(makeTask("quota ranking"));
  const content = result.artifacts[0]?.content;

  assert.equal(typeof content, "string");
  assert.match(content as string, /measured-account.*25 remaining/);
  assert.match(content as string, /unknown-account.*unknown remaining/);
  assert.doesNotMatch(content as string, /unlimited|∞/);
});

test("A2A quota summary does not aggregate synthetic unknown capacity", async () => {
  installQuotaResponses();
  const result = await executeQuotaManagement(makeTask("quota summary"));
  const content = result.artifacts[0]?.content;

  assert.equal(typeof content, "string");
  assert.match(content as string, /unknown-account.*quota unknown/);
  assert.match(content as string, /known \(1 with unknown capacity\)/);
  assert.doesNotMatch(content as string, /∞/);
});
