const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
const DEEPSEEK_FLASH_RELEASE_URL = "https://api-docs.deepseek.com/news/news260910/";
const SOURCE_RETRIEVED_AT = "2026-10-13T06:15:58.000Z";
const SOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FLASH_RATES = {
  inputCacheMiss: { offPeak: 0.15, peak: 0.3 },
  inputCacheHit: { offPeak: 0.003, peak: 0.006 },
  output: { offPeak: 0.6, peak: 1.2 },
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
      pricingCondition:
        "input-cache-miss, input-cache-hit, and output rates vary by the provider's UTC peak/off-peak schedule",
      routeResolution: {
        modelVersion: "DeepSeek-V4.1-Flash",
        source: source(now, DEEPSEEK_FLASH_RELEASE_URL, "deepseek.api_model_routing"),
      },
      zeroCostEligibility: "no",
    } as const;
  }

  if (modelId === "deepseek-v4-pro") {
    return {
      state: "conditional_reported_pricing",
      routeModelId: modelId,
      resolvedModelId: "deepseek-v4-pro",
      servedModelVersion: "DeepSeek-V4.1-Flash",
      currency: "USD",
      rateUnit: "USD / 1M tokens",
      rates: FLASH_RATES,
      pricingCondition:
        "DeepSeek currently routes deepseek-v4-pro requests to V4.1-Flash and bills at Flash rates until V4.1-Pro launches; rates also vary by the provider's UTC peak/off-peak schedule",
      source: source(now),
      routeResolution: {
        modelVersion: "DeepSeek-V4.1-Flash",
        source: source(now, DEEPSEEK_FLASH_RELEASE_URL, "deepseek.api_model_routing"),
      },
      zeroCostEligibility: "no",
    } as const;
  }

  return null;
}
