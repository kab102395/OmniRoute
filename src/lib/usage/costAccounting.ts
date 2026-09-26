/**
 * Conservative classification for synchronous chat accounting facts.
 * Local pricing rows are estimates because OmniRoute does not retain their
 * effective date/version and they are not provider invoices.
 */

export type CostAccountingKind =
  "provider_reported_billed_cost" | "estimated_cost" | "usage_only" | "unknown" | "zero_cost";

export type CostAccountingFacts = {
  kind: CostAccountingKind;
  amountUsd: number | null;
  currency: "USD" | null;
  source: string | null;
  pricingProvider: string | null;
  pricingModel: string | null;
  pricingVersion: null;
  pricingEffectiveAt: null;
  usageKind: "provider_reported_usage" | "estimated_usage" | "unknown";
};

function hasUsage(usage: Record<string, unknown> | null | undefined): boolean {
  if (!usage) return false;
  return [
    "prompt_tokens",
    "completion_tokens",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_tokens",
  ].some((field) => {
    const value = usage[field];
    return typeof value === "number" && Number.isFinite(value);
  });
}

export function classifyCostAccounting(args: {
  provider: string | null | undefined;
  model: string | null | undefined;
  usage: Record<string, unknown> | null | undefined;
  calculatedCostUsd: number | null | undefined;
}): CostAccountingFacts {
  const ticks = args.usage?.cost_in_usd_ticks;
  const usageKind = args.usage?.estimated === true ? "estimated_usage" : "provider_reported_usage";
  const identity = {
    pricingProvider: args.provider || null,
    pricingModel: args.model || null,
    pricingVersion: null as null,
    pricingEffectiveAt: null as null,
  };

  if (typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0) {
    const amountUsd = ticks / 10_000_000_000;
    return {
      kind: amountUsd === 0 ? "zero_cost" : "provider_reported_billed_cost",
      amountUsd,
      currency: "USD",
      source: "provider_usage.cost_in_usd_ticks",
      ...identity,
      usageKind,
    };
  }

  const reportedCost = args.usage?.provider_reported_cost_usd;
  if (
    args.provider?.toLowerCase() === "openrouter" &&
    typeof reportedCost === "number" &&
    Number.isFinite(reportedCost) &&
    reportedCost >= 0
  ) {
    return {
      kind: reportedCost === 0 ? "zero_cost" : "provider_reported_billed_cost",
      amountUsd: reportedCost,
      currency: "USD",
      source: "openrouter_response.usage.cost",
      ...identity,
      usageKind,
    };
  }

  const calculatedCostUsd = Number(args.calculatedCostUsd);
  if (Number.isFinite(calculatedCostUsd) && calculatedCostUsd > 0) {
    return {
      kind: "estimated_cost",
      amountUsd: calculatedCostUsd,
      currency: "USD",
      source: "omniroute_local_pricing_table",
      ...identity,
      usageKind,
    };
  }

  if (hasUsage(args.usage)) {
    return {
      kind: "usage_only",
      amountUsd: null,
      currency: null,
      source: null,
      ...identity,
      usageKind,
    };
  }

  return {
    kind: "unknown",
    amountUsd: null,
    currency: null,
    source: null,
    pricingProvider: null,
    pricingModel: null,
    pricingVersion: null,
    pricingEffectiveAt: null,
    usageKind: "unknown",
  };
}
