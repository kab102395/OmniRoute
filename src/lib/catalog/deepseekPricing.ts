const DEEPSEEK_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing/";
const DEEPSEEK_FLASH_RELEASE_URL = "https://api-docs.deepseek.com/news/news260910/";
const SOURCE_RETRIEVED_AT = "2026-10-13T03:50:00.000Z";
const SOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FLASH_RATES = {
  inputCacheMiss: { offPeak: 0.15, peak: 0.3 },
  inputCacheHit: { offPeak: 0.003, peak: 0.006 },
  output: { offPeak: 0.6, peak: 1.2 },
} as const;

function source(now: number, url = DEEPSEEK_PRICING_URL) {
  const retrievedAtMs = Date.parse(SOURCE_RETRIEVED_AT);
  return {
    id: "deepseek.api_pricing",
    url,
    retrievedAt: SOURCE_RETRIEVED_AT,
    cacheTtlMs: SOURCE_TTL_MS,
    stale: !Number.isFinite(retrievedAtMs) || now - retrievedAtMs > SOURCE_TTL_MS,
  };
}

/** Provider-maintained evidence for current DeepSeek API routes and their legacy aliases. */
export function getDeepseekPricingEvidence(modelId: string, now = Date.now()) {
  if (modelId === "deepseek-flash" || modelId === "deepseek-v4-flash") {
    return {
      state: "conditional_reported_pricing",
      routeModelId: modelId,
      resolvedModelId: "deepseek-flash",
      currency: "USD",
      rateUnit: "USD / 1M tokens",
      rates: FLASH_RATES,
      source: source(now, modelId === "deepseek-v4-flash" ? DEEPSEEK_FLASH_RELEASE_URL : undefined),
      pricingCondition:
        "input-cache-miss, input-cache-hit, and output rates vary by the provider's UTC peak/off-peak schedule",
      zeroCostEligibility: "no",
    } as const;
  }

  if (modelId === "deepseek-v4-pro") {
    return {
      state: "conditional_reported_pricing",
      routeModelId: modelId,
      resolvedModelId: "deepseek-flash",
      currency: "USD",
      rateUnit: "USD / 1M tokens",
      rates: FLASH_RATES,
      pricingCondition:
        "All deepseek-v4-pro requests route to V4.1-Flash at Flash rates until V4.1-Pro launches",
      source: source(now, DEEPSEEK_FLASH_RELEASE_URL),
      zeroCostEligibility: "no",
    } as const;
  }

  return null;
}
