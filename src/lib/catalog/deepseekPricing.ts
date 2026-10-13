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
      state: "ambiguous_route_and_pricing",
      routeModelId: modelId,
      currency: "USD",
      rateUnit: "USD / 1M tokens",
      // `/quick_start/pricing` lists Pro-0813 rates, while the V4.1 Flash release
      // notice says v4-pro is routed to Flash at Flash rates. The public sources
      // do not currently establish which applies to this requested legacy id.
      pricingCandidates: [
        { modelId: "deepseek-v4-pro", source: source(now) },
        {
          modelId: "deepseek-flash",
          source: source(now, DEEPSEEK_FLASH_RELEASE_URL),
          rates: FLASH_RATES,
        },
      ],
      conservativeEstimate: { input: 1.32, cached: 0.044, output: 3.96 },
      source: source(now),
      zeroCostEligibility: "no",
    } as const;
  }

  return null;
}
