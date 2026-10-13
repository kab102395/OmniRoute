import {
  FREE_MODEL_BUDGETS,
  grantsFreeAccess,
  type FreeModelBudget,
} from "@omniroute/open-sse/config/freeModelCatalog";
import { resolveProviderId } from "@/shared/constants/providers";

export interface CatalogFreeAccess {
  classification: "documented_free_tier";
  freeType: FreeModelBudget["freeType"];
  monthlyTokens: number;
  creditTokens: number;
  hardStopGuaranteed: boolean | null;
  accountEligibility: "unknown";
  zeroCostOnExhaustion: "provider_hard_stop" | "not_guaranteed";
  termsOfService: FreeModelBudget["tos"];
  source: {
    id: "omniroute.free_model_catalog";
    freshness: "release_catalog";
    retrievedAt: null;
  };
}

const FREE_ACCESS_BY_ROUTE = new Map<string, FreeModelBudget>();
for (const entry of FREE_MODEL_BUDGETS) {
  if (!grantsFreeAccess(entry.freeType) || resolveProviderId(entry.provider) === "openrouter") {
    continue;
  }
  const canonicalProvider = resolveProviderId(entry.provider);
  FREE_ACCESS_BY_ROUTE.set(`${entry.provider}:${entry.modelId}`, entry);
  FREE_ACCESS_BY_ROUTE.set(`${canonicalProvider}:${entry.modelId}`, entry);
}

/**
 * Return the curated free-tier facts for one exact provider/model route.
 * This describes an offering, not this account's live quota or a guaranteed
 * zero-cost route. OpenRouter is excluded because its free variants rotate and
 * must be checked against its current upstream catalog instead.
 */
export function getCatalogFreeAccess(provider: string, modelId: string): CatalogFreeAccess | null {
  const providerId = resolveProviderId(provider);
  const entry =
    FREE_ACCESS_BY_ROUTE.get(`${provider}:${modelId}`) ||
    FREE_ACCESS_BY_ROUTE.get(`${providerId}:${modelId}`);
  if (!entry) return null;

  return {
    classification: "documented_free_tier",
    freeType: entry.freeType,
    monthlyTokens: entry.monthlyTokens,
    creditTokens: entry.creditTokens,
    hardStopGuaranteed: entry.hardStopGuaranteed ?? null,
    accountEligibility: "unknown",
    zeroCostOnExhaustion:
      entry.hardStopGuaranteed === true ? "provider_hard_stop" : "not_guaranteed",
    termsOfService: entry.tos,
    source: {
      id: "omniroute.free_model_catalog",
      freshness: "release_catalog",
      retrievedAt: null,
    },
  };
}
