/**
 * A2A Skill: Smart Routing
 *
 * Receives a prompt + metadata → routes via OmniRoute pipeline →
 * returns response with routing_explanation, cost_envelope, resilience_trace, policy_verdict.
 */

import type { A2ATask, TaskArtifact } from "../taskManager";
import { resolveOmniRouteBaseUrl } from "@/shared/utils/resolveOmniRouteBaseUrl";

const OMNIROUTE_BASE_URL = resolveOmniRouteBaseUrl();
const OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY || "";

export interface SmartRoutingResult {
  artifacts: TaskArtifact[];
  metadata: {
    routing_explanation: string;
    cost_envelope: { estimated: number | null; actual: number | null; currency: string | null };
    execution: {
      request_id: string | null;
      requested_model: string;
      served_model: string | null;
      served_provider: string | null;
      accounting_kind: string | null;
      accounting_source: string | null;
      usage_kind: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      pricing_retrieved_at: string | null;
      pricing_stale: boolean | null;
      fallback_attempts: number;
    };
    resilience_trace: Array<{ event: string; provider: string; timestamp: string }>;
    policy_verdict: { allowed: boolean; evaluated_after_execution: true; reason: string };
  };
}

function finiteHeaderNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function booleanHeader(headers: Headers, name: string): boolean | null {
  const value = headers.get(name)?.toLowerCase();
  return value === "true" ? true : value === "false" ? false : null;
}

export function readSmartRoutingReceipt(response: Response, requestedModel: string) {
  const headers = response.headers;
  const kind = headers.get("X-OmniRoute-Accounting-Kind");
  const responseCost = finiteHeaderNumber(headers, "X-OmniRoute-Response-Cost");
  const usageKind = headers.get("X-OmniRoute-Usage-Kind");
  const knownCost =
    kind === "estimated_cost"
      ? "estimated"
      : kind === "provider_reported_billed_cost" || kind === "zero_cost"
        ? "actual"
        : null;
  const fallbackAttempts = finiteHeaderNumber(headers, "X-OmniRoute-Fallback-Attempts");

  return {
    estimated: knownCost === "estimated" ? responseCost : null,
    actual: knownCost === "actual" ? responseCost : null,
    currency: responseCost === null ? null : headers.get("X-OmniRoute-Cost-Currency") || "USD",
    accountingKind: kind,
    accountingSource: headers.get("X-OmniRoute-Cost-Source"),
    usageKind,
    inputTokens:
      usageKind === "provider_reported_usage" || usageKind === "estimated_usage"
        ? finiteHeaderNumber(headers, "X-OmniRoute-Tokens-In")
        : null,
    outputTokens:
      usageKind === "provider_reported_usage" || usageKind === "estimated_usage"
        ? finiteHeaderNumber(headers, "X-OmniRoute-Tokens-Out")
        : null,
    pricingRetrievedAt: headers.get("X-OmniRoute-Pricing-Retrieved-At"),
    pricingStale: booleanHeader(headers, "X-OmniRoute-Pricing-Stale"),
    requestId: headers.get("X-OmniRoute-Request-Id"),
    servedModel: headers.get("X-OmniRoute-Served-Model"),
    servedProvider:
      headers.get("X-OmniRoute-Served-Provider") || headers.get("X-OmniRoute-Provider"),
    fallbackAttempts: fallbackAttempts === null ? 0 : Math.floor(fallbackAttempts),
    requestedModel,
  };
}

export async function executeSmartRouting(task: A2ATask): Promise<SmartRoutingResult> {
  const messages = task.input.messages;
  const model = (task.input.metadata?.model as string) || "auto";
  const combo = task.input.metadata?.combo as string | undefined;
  const budget = task.input.metadata?.budget as number | undefined;

  const start = Date.now();
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (combo) body["x-combo"] = combo;

  const response = await fetch(`${OMNIROUTE_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(OMNIROUTE_API_KEY ? { Authorization: `Bearer ${OMNIROUTE_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`API [${response.status}]: ${await response.text().catch(() => "error")}`);
  const raw = await response.json();
  const latencyMs = Date.now() - start;

  const content = raw?.choices?.[0]?.message?.content || "";
  const receipt = readSmartRoutingReceipt(response, model);
  const provider = receipt.servedProvider || "unknown";

  // This is a post-execution observation only; admission belongs to the caller.
  const observedCost = receipt.actual ?? receipt.estimated;
  const withinBudget = budget === undefined || (observedCost !== null && observedCost <= budget);

  return {
    artifacts: [{ type: "text", content }],
    metadata: {
      routing_explanation: `Selected ${receipt.servedModel || raw?.model || model} via provider "${provider}" (latency: ${latencyMs}ms${observedCost === null ? ", cost unknown" : `, cost: $${observedCost.toFixed(4)}`})`,
      cost_envelope: {
        estimated:
          receipt.estimated === null ? null : Math.round(receipt.estimated * 10000) / 10000,
        actual: receipt.actual === null ? null : Math.round(receipt.actual * 10000) / 10000,
        currency: receipt.currency,
      },
      execution: {
        request_id: receipt.requestId,
        requested_model: receipt.requestedModel,
        served_model: receipt.servedModel,
        served_provider: receipt.servedProvider,
        accounting_kind: receipt.accountingKind,
        accounting_source: receipt.accountingSource,
        usage_kind: receipt.usageKind,
        input_tokens: receipt.inputTokens,
        output_tokens: receipt.outputTokens,
        pricing_retrieved_at: receipt.pricingRetrievedAt,
        pricing_stale: receipt.pricingStale,
        fallback_attempts: receipt.fallbackAttempts,
      },
      resilience_trace: [
        { event: "primary_selected", provider, timestamp: new Date().toISOString() },
        ...(receipt.fallbackAttempts > 0
          ? [
              {
                event: "fallback_attempts_observed",
                provider,
                timestamp: new Date().toISOString(),
              },
            ]
          : []),
      ],
      policy_verdict: {
        allowed: withinBudget,
        evaluated_after_execution: true,
        reason: withinBudget
          ? observedCost === null
            ? "execution completed; cost is unknown and this post-execution observation is not admission control"
            : `execution completed at reported or estimated cost $${observedCost}; this post-execution observation is not admission control`
          : `observed cost $${observedCost} exceeds budget $${budget}; execution already completed`,
      },
    },
  };
}
