/**
 * Conservative classification for synchronous chat accounting facts.
 * Local pricing rows are estimates because OmniRoute does not retain their
 * effective date/version and they are not provider invoices.
 */

import { parseUsdTicks } from "./usdDecimal";

export type CostAccountingKind =
  "provider_reported_billed_cost" | "estimated_cost" | "usage_only" | "unknown" | "zero_cost";

export type CostAccountingFacts = {
  kind: CostAccountingKind;
  amountUsd: number | null;
  /** Exact decimal charge when supplied as integer USD ticks by the provider. */
  amountUsdExact?: string;
  currency: "USD" | null;
  source: string | null;
  pricingProvider: string | null;
  pricingModel: string | null;
  pricingVersion: null;
  pricingEffectiveAt: null;
  pricingRetrievedAt: string | null;
  pricingStale: boolean | null;
  pricingCondition?: string | null;
  usageKind: "provider_reported_usage" | "estimated_usage" | "unknown";
};

function accountingSource(
  source: import("./costCalculator").CostPricingEvidence["source"]
): string | null {
  switch (source) {
    case "modelsDev":
      return "models_dev.api_json";
    case "litellm":
      return "litellm.model_prices";
    case "user":
      return "omniroute.user_pricing";
    case "default":
      return "omniroute.static_pricing";
    case "deepseek":
      return "deepseek.api_pricing";
    default:
      return null;
  }
}

export function classifyModalCostAccounting(args: {
  provider: string;
  model: string;
  costUsd: number | null;
  pricingEvidence: import("./costCalculator").CostPricingEvidence;
}): CostAccountingFacts {
  const source = accountingSource(args.pricingEvidence.source);
  const common = {
    currency: args.costUsd === null ? null : ("USD" as const),
    source,
    pricingProvider: args.provider || null,
    pricingModel: args.model || args.pricingEvidence.modelId,
    pricingVersion: null as null,
    pricingEffectiveAt: null as null,
    pricingRetrievedAt:
      args.pricingEvidence.retrievedAt === null
        ? null
        : new Date(args.pricingEvidence.retrievedAt).toISOString(),
    pricingStale: args.pricingEvidence.stale,
    pricingCondition: args.pricingEvidence.condition ?? null,
    usageKind: "estimated_usage" as const,
  };
  if (args.costUsd === null) {
    return { kind: "unknown", amountUsd: null, ...common };
  }
  if (!Number.isFinite(args.costUsd) || args.costUsd < 0) {
    return { kind: "unknown", amountUsd: null, ...common, currency: null };
  }
  return {
    // Modal routes currently have no common provider-reported billing receipt;
    // a local $0 calculation is still an estimate, not verified zero-cost use.
    kind: "estimated_cost",
    amountUsd: args.costUsd,
    ...common,
  };
}

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
  /** True only when OmniRoute has complete, valid rates for every billed dimension. */
  calculatedCostKnown?: boolean;
  pricingEvidence?: import("./costCalculator").CostPricingEvidence | null;
}): CostAccountingFacts {
  const ticks = args.usage?.cost_in_usd_ticks;
  const usageKind =
    args.usage?.estimated === true
      ? "estimated_usage"
      : hasUsage(args.usage)
        ? "provider_reported_usage"
        : "unknown";
  const identity = {
    pricingProvider: args.provider || null,
    pricingModel: args.model || null,
    pricingVersion: null as null,
    pricingEffectiveAt: null as null,
    pricingRetrievedAt: null as string | null,
    pricingStale: null as boolean | null,
    pricingCondition: null as string | null,
  };

  const tickAmount = parseUsdTicks(ticks);
  if (tickAmount) {
    const amountUsd = tickAmount.amountUsd;
    return {
      kind: amountUsd === 0 ? "zero_cost" : "provider_reported_billed_cost",
      amountUsd,
      amountUsdExact: tickAmount.amountUsdExact,
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
  if (
    Number.isFinite(calculatedCostUsd) &&
    calculatedCostUsd >= 0 &&
    (calculatedCostUsd > 0 || args.calculatedCostKnown === true)
  ) {
    const pricingSource = args.pricingEvidence?.source;
    const source =
      pricingSource === "modelsDev"
        ? "models_dev.api_json"
        : pricingSource === "litellm"
          ? "litellm.model_prices"
          : pricingSource === "user"
            ? "omniroute.user_pricing"
            : pricingSource === "default"
              ? "omniroute.static_pricing"
              : pricingSource === "deepseek"
                ? "deepseek.api_pricing"
                : "omniroute_local_pricing_table";
    return {
      kind: "estimated_cost",
      amountUsd: calculatedCostUsd,
      currency: "USD",
      source,
      ...identity,
      pricingRetrievedAt: args.pricingEvidence?.retrievedAt ?? null,
      pricingStale: args.pricingEvidence?.stale ?? null,
      pricingCondition: args.pricingEvidence?.condition ?? null,
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
    pricingRetrievedAt: null,
    pricingStale: null,
    pricingCondition: null,
    usageKind: "unknown",
  };
}
