import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { sanitizeProviderBillingStatus } from "@/shared/utils/providerBilling";
import { GROK_BUILD_ADDITIONAL_CREDITS_URL } from "@/shared/utils/grokBilling";

const GROK_CLI_PROVIDER = "grok-cli";

type JsonRecord = Record<string, unknown>;

export type ProviderLimitsCacheFreshness = {
  status: "fresh" | "stale" | "unknown";
  ageMs: number | null;
  maxAgeMs: number;
};

export type ProviderLimitsApiCacheEntry = ProviderLimitsCacheEntry & {
  freshness: ProviderLimitsCacheFreshness;
};

/** Add response-time age facts without persisting derived freshness in the cache. */
export function addProviderLimitsFreshness(
  caches: Record<string, ProviderLimitsCacheEntry>,
  maxAgeMs: number,
  now = Date.now()
): Record<string, ProviderLimitsApiCacheEntry> {
  return Object.fromEntries(
    Object.entries(caches).map(([connectionId, entry]) => {
      const fetchedAtMs = Date.parse(entry.fetchedAt);
      const ageMs = Number.isFinite(fetchedAtMs) && fetchedAtMs <= now ? now - fetchedAtMs : null;
      const status = ageMs === null ? "unknown" : ageMs <= maxAgeMs ? "fresh" : "stale";
      return [
        connectionId,
        {
          ...entry,
          freshness: { status, ageMs, maxAgeMs },
        },
      ];
    })
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasUsableCachedData(cache: ProviderLimitsCacheEntry | null | undefined): boolean {
  return Boolean(cache?.billing || (cache?.quotas && Object.keys(cache.quotas).length > 0));
}

export function toProviderLimitsCacheEntry(
  usage: JsonRecord,
  source: string,
  fetchedAt = new Date().toISOString()
): ProviderLimitsCacheEntry {
  const bankedResetCredits = Number(usage.bankedResetCredits);
  return {
    quotas: isRecord(usage.quotas) ? usage.quotas : null,
    plan: usage.plan ?? null,
    message: typeof usage.message === "string" ? usage.message : null,
    fetchedAt,
    source,
    bankedResetCredits: Number.isFinite(bankedResetCredits) ? bankedResetCredits : undefined,
    billing: sanitizeProviderBillingStatus(usage.billing),
  };
}

export function mergeProviderLimitsCacheEntry(
  provider: string,
  next: ProviderLimitsCacheEntry,
  previous: ProviderLimitsCacheEntry | null | undefined
): ProviderLimitsCacheEntry {
  if (!previous) return next;

  // OpenRouter includes locally tracked free-window rows even when both
  // upstream credit endpoints fail. Preserve the last successful account
  // observation instead of replacing it with those fallback-only rows.
  if (provider === "openrouter" && next.message && hasUsableCachedData(previous)) {
    return previous;
  }

  if (!next.quotas && next.message && hasUsableCachedData(previous)) {
    return previous;
  }

  if (provider !== GROK_CLI_PROVIDER) return next;

  const nextBilling = next.billing;
  const previousBilling = previous.billing;
  if (
    !nextBilling ||
    nextBilling.additionalCreditsUrl !== GROK_BUILD_ADDITIONAL_CREDITS_URL ||
    nextBilling.autoTopUp.available ||
    !previousBilling ||
    previousBilling.additionalCreditsUrl !== GROK_BUILD_ADDITIONAL_CREDITS_URL
  )
    return next;

  return {
    ...next,
    billing: {
      ...nextBilling,
      autoTopUp: previousBilling.autoTopUp,
    },
  };
}
