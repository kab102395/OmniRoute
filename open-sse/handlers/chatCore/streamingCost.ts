/**
 * chatCore streaming per-request cost recording (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete: resolves the real per-request cost for a
 * completed streaming response and records it against the api key. onStreamComplete is synchronous,
 * so this is a sync fire-and-forget driven through calculateCost().then().catch() that never throws
 * to the caller. calculateCost and recordCost are injected so the hook stays decoupled. Behaviour
 * is byte-identical to the previous inline block.
 */

type CostResolver = (
  provider: string,
  model: string,
  usage: Record<string, number | undefined> | null | undefined,
  options: { serviceTier?: string; requestCount?: number }
) => Promise<{
  costUsd: number;
  costKnown: boolean;
  pricingEvidence: import("@/lib/usage/costCalculator").CostPricingEvidence;
}>;

export function recordStreamingCost(args: {
  apiKeyId: string | null | undefined;
  provider: string | null | undefined;
  model: string | null | undefined;
  streamUsage: Record<string, number | undefined> | null | undefined;
  serviceTier?: string;
  requestCount?: number;
  calculateCostWithEvidence: CostResolver;
  recordCostAssessment: (apiKeyId: string, costUsd: number, costKnown: boolean) => void;
}): void {
  if (!args.apiKeyId) return;

  const apiKeyId = args.apiKeyId;
  if (!args.streamUsage) {
    args.recordCostAssessment(apiKeyId, 0, false);
    return;
  }
  args
    .calculateCostWithEvidence(args.provider, args.model, args.streamUsage, {
      serviceTier: args.serviceTier,
      requestCount: args.requestCount,
    })
    .then((assessment) => {
      args.recordCostAssessment(apiKeyId, assessment.costUsd, assessment.costKnown);
    })
    .catch(() => args.recordCostAssessment(apiKeyId, 0, false));
}
