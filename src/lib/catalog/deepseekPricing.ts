import type { ModelPricingProvenance } from "@/domain/modelCatalogContract";

const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
const DEEPSEEK_FLASH_RELEASE_URL = "https://api-docs.deepseek.com/news/news260910/";
const SOURCE_RETRIEVED_AT = "2026-10-13T20:08:48.000Z";
const SOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PEAK_OFFPEAK_PRICING_CONDITION =
  "input-cache-miss, input-cache-hit, and output rates vary by the provider's schedule: peak is 01:00-04:00 and 06:00-10:00 UTC Monday through Friday, excluding Chinese public holidays; all other times are off-peak";

const FLASH_RATES = {
  inputCacheMiss: { offPeak: "0.15", peak: "0.3" },
  inputCacheHit: { offPeak: "0.003", peak: "0.006" },
  output: { offPeak: "0.6", peak: "1.2" },
} as const;

const PRO_RATES = {
  inputCacheMiss: { offPeak: "0.66", peak: "1.32" },
  inputCacheHit: { offPeak: "0.022", peak: "0.044" },
  output: { offPeak: "1.98", peak: "3.96" },
} as const;

function source(now: number, url = DEEPSEEK_PRICING_URL, id = "deepseek.api_pricing") {
  const retrievedAtMs = Date.parse(SOURCE_RETRIEVED_AT);
  return {
    id,
    url,
    retrievedAt: SOURCE_RETRIEVED_AT,
    cacheTtlMs: SOURCE_TTL_MS,
    stale:
      !Number.isFinite(retrievedAtMs) || retrievedAtMs > now || now - retrievedAtMs > SOURCE_TTL_MS,
  };
}

/** Provider-maintained evidence for current DeepSeek API routes and their legacy aliases. */
export function getDeepseekPricingEvidence(modelId: string, now = Date.now()) {
  if (
    modelId === "deepseek-flash" ||
    modelId === "deepseek-v4-flash" ||
    modelId === "deepseek-v4-flash-vision-exp"
  ) {
    return {
      state: "conditional_reported_pricing",
      routeModelId: modelId,
      resolvedModelId: "deepseek-flash",
      servedModelVersion: "DeepSeek-V4.1-Flash",
      currency: "USD",
      rateUnit: "USD / 1M tokens",
      rates: FLASH_RATES,
      source: source(now),
      pricingCondition: PEAK_OFFPEAK_PRICING_CONDITION,
      routeResolution: {
        modelVersion: "DeepSeek-V4.1-Flash",
        source: source(now, DEEPSEEK_FLASH_RELEASE_URL, "deepseek.api_model_routing"),
      },
      zeroCostEligibility: "no",
    } satisfies ModelPricingProvenance;
  }

  if (modelId === "deepseek-v4-pro") {
    const pricingSource = source(now);
    return {
      state: "conditional_reported_pricing",
      routeModelId: modelId,
      resolvedModelId: "deepseek-v4-pro",
      servedModelVersion: "DeepSeek-V4-Pro-0813",
      currency: "USD",
      rateUnit: "USD / 1M tokens",
      rates: PRO_RATES,
      pricingCondition: `${PEAK_OFFPEAK_PRICING_CONDITION}; estimate uses peak rates as the conservative schedule bound.`,
      source: pricingSource,
      routeResolution: {
        modelVersion: "DeepSeek-V4-Pro-0813",
        source: pricingSource,
      },
      zeroCostEligibility: "no",
    } satisfies ModelPricingProvenance;
  }

  return null;
}
