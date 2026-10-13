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
  pricingRateSources?: import("./costCalculator").CostPricingEvidence["rateSources"];
  usageKind: "provider_reported_usage" | "estimated_usage" | "unknown";
  /** OpenRouter's serving host as reported after the generation completed. */
  downstreamProvider?: string;
  /** Per-upstream-generation receipts, including retries when OpenRouter reports them. */
  providerReceipts?: import("./openrouterGeneration").OpenRouterGenerationReceipt[];
  providerReceiptsComplete?: boolean;
  providerReceiptMissingIds?: string[];
  providerReceiptIncompleteIds?: string[];
  providerReceiptsTruncated?: boolean;
  providerRequestId?: string;
};

function numberToDecimalString(value: number): string {
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const [coefficient, exponentText] = raw.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const point = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const decimalIndex = (point === -1 ? unsigned.length : point) + exponent;
  const expanded =
    decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return `${negative ? "-" : ""}${expanded}`;
}

function sumUsdDecimals(values: readonly number[]): {
  readonly amountUsd: number | null;
  readonly amountUsdExact: string;
} {
  const decimals = values.map(numberToDecimalString);
  const scale = decimals.reduce((max, value) => Math.max(max, value.split(".")[1]?.length ?? 0), 0);
  const total = decimals.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    const sign = whole.startsWith("-") ? -1n : 1n;
    const wholeDigits = whole.replace("-", "");
    const fractionDigits = fraction.padEnd(scale, "0");
    const units = BigInt(`${wholeDigits}${fractionDigits}` || "0");
    return sum + sign * units;
  }, 0n);
  const isNegative = total < 0n;
  const digits = (isNegative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  const amountUsdExact = `${isNegative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
  const amountUsd = Number(amountUsdExact);
  return {
    amountUsd: Number.isFinite(amountUsd) ? amountUsd : null,
    amountUsdExact,
  };
}

/**
 * Merge OpenRouter's authenticated post-generation receipts into the existing
 * accounting snapshot. Aggregate cost is authoritative only when every
 * requested generation has a returned receipt with a reported total cost.
 */
export function applyOpenRouterGenerationReceipts(
  accounting: CostAccountingFacts,
  requestedGenerationIds: readonly string[],
  receipts: import("./openrouterGeneration").OpenRouterGenerationReceipt[]
): CostAccountingFacts {
  if (requestedGenerationIds.length === 0) return accounting;
  const uniqueRequestedIds = [...new Set(requestedGenerationIds)];
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const requestedReceipts = uniqueRequestedIds.map((id) => receiptById.get(id));
  const missingIds = uniqueRequestedIds.filter((id) => !receiptById.has(id));
  const incompleteIds = uniqueRequestedIds.filter((id) => {
    const receipt = receiptById.get(id);
    return !receipt || receipt.totalCostUsd === null || receipt.isByok !== false;
  });
  const complete =
    accounting.providerReceiptsTruncated !== true &&
    requestedReceipts.length > 0 &&
    requestedReceipts.every(
      (receipt) =>
        receipt !== undefined && receipt.totalCostUsd !== null && receipt.isByok === false
    );
  const latestReceipt = requestedReceipts.at(-1);
  const providerReceipts = receipts;
  const result: CostAccountingFacts = {
    ...accounting,
    providerReceipts,
    providerReceiptsComplete:
      incompleteIds.length === 0 && accounting.providerReceiptsTruncated !== true,
    ...(missingIds.length > 0 ? { providerReceiptMissingIds: missingIds } : {}),
    ...(incompleteIds.length > 0 ? { providerReceiptIncompleteIds: incompleteIds } : {}),
    ...(latestReceipt?.providerName ? { downstreamProvider: latestReceipt.providerName } : {}),
    ...(latestReceipt?.id ? { providerRequestId: latestReceipt.id } : {}),
  };
  if (!complete) return result;

  const { amountUsd, amountUsdExact } = sumUsdDecimals(
    requestedReceipts.map((receipt) => receipt?.totalCostUsd ?? 0)
  );
  return {
    ...result,
    kind: amountUsdExact === "0" ? "zero_cost" : "provider_reported_billed_cost",
    amountUsd,
    amountUsdExact,
    currency: "USD",
    source: "openrouter.generation_api.total_cost",
    pricingProvider: "openrouter",
    pricingModel: latestReceipt?.model || accounting.pricingModel,
    usageKind: "provider_reported_usage",
  };
}

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
    case "openrouter":
      return "openrouter.models_api";
    case "mixed":
      return "omniroute.mixed_pricing_sources";
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
      args.pricingEvidence.source === "mixed" || args.pricingEvidence.retrievedAt === null
        ? null
        : new Date(args.pricingEvidence.retrievedAt).toISOString(),
    pricingStale: args.pricingEvidence.stale,
    pricingCondition: args.pricingEvidence.condition ?? null,
    ...(args.pricingEvidence.rateSources
      ? { pricingRateSources: args.pricingEvidence.rateSources }
      : {}),
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
    "input_audio_tokens",
    "output_audio_tokens",
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
      amountUsdExact: numberToDecimalString(reportedCost),
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
                : pricingSource === "openrouter"
                  ? "openrouter.models_api"
                  : pricingSource === "mixed"
                    ? "omniroute.mixed_pricing_sources"
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
      ...(args.pricingEvidence?.rateSources
        ? { pricingRateSources: args.pricingEvidence.rateSources }
        : {}),
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
      pricingRetrievedAt:
        args.pricingEvidence?.source === "mixed"
          ? null
          : (args.pricingEvidence?.retrievedAt ?? null),
      pricingStale: args.pricingEvidence?.stale ?? null,
      pricingCondition: args.pricingEvidence?.condition ?? null,
      ...(args.pricingEvidence?.rateSources
        ? { pricingRateSources: args.pricingEvidence.rateSources }
        : {}),
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
