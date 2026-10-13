import { getCurrentOpenRouterFreeRouteIds } from "@/lib/catalog/openrouterCatalog";
import { getSyncedAvailableModelsByConnection } from "@/lib/db/models";
import { resolveProviderId } from "@/shared/constants/providers";
import { isFreeModel } from "@/shared/utils/freeModels";

export type FreeRouteAdmission =
  | {
      readonly kind: "eligible";
      readonly source:
        "openrouter.models_api" | "huggingface.router_models_api" | "omniroute.free_model_catalog";
    }
  | { readonly kind: "ineligible"; readonly reason: "catalog_unverified" | "not_free" };

/**
 * Check the selected route at dispatch time. OpenRouter membership must come
 * from its fresh exact-route catalog; other providers use OmniRoute's existing
 * curated exact model catalog. This classifies route eligibility only: account
 * quota and provider billing enforcement remain separate facts.
 */
export async function checkFreeRouteAdmission(
  provider: string,
  model: string
): Promise<FreeRouteAdmission> {
  if (resolveProviderId(provider) === "openrouter") {
    const currentFreeRoutes = await getCurrentOpenRouterFreeRouteIds();
    if (currentFreeRoutes === null) {
      return { kind: "ineligible", reason: "catalog_unverified" };
    }

    const exactRouteId = model.replace(/^openrouter\//, "");
    const isDynamicFreeRouter = exactRouteId === "free" && currentFreeRoutes.size > 0;
    return currentFreeRoutes.has(exactRouteId) || isDynamicFreeRouter
      ? { kind: "eligible", source: "openrouter.models_api" }
      : { kind: "ineligible", reason: "not_free" };
  }

  if (resolveProviderId(provider) === "huggingface") {
    const separator = model.lastIndexOf(":");
    if (separator <= 0 || separator === model.length - 1) {
      return { kind: "ineligible", reason: "not_free" };
    }
    const baseModelId = model.slice(0, separator).replace(/^(?:hf|huggingface)\//, "");
    const providerRoute = model.slice(separator + 1);
    const byConnection = await getSyncedAvailableModelsByConnection("huggingface");
    const syncedModel = Object.values(byConnection)
      .flat()
      .filter((entry) => entry.id === baseModelId)
      .sort((left, right) => {
        const leftTime = Date.parse(left.providerRoutesRetrievedAt ?? "");
        const rightTime = Date.parse(right.providerRoutesRetrievedAt ?? "");
        return rightTime - leftTime;
      })[0];
    const retrievedAt = syncedModel?.providerRoutesRetrievedAt
      ? Date.parse(syncedModel.providerRoutesRetrievedAt)
      : Number.NaN;
    if (
      !Number.isFinite(retrievedAt) ||
      retrievedAt > Date.now() ||
      Date.now() - retrievedAt > 15 * 60 * 1000
    ) {
      return { kind: "ineligible", reason: "catalog_unverified" };
    }
    const route = syncedModel?.providerRoutes?.find((entry) => entry.provider === providerRoute);
    return route?.status === "live" && route.isFree === true
      ? { kind: "eligible", source: "huggingface.router_models_api" }
      : { kind: "ineligible", reason: "not_free" };
  }

  return isFreeModel(provider, { id: model })
    ? { kind: "eligible", source: "omniroute.free_model_catalog" }
    : { kind: "ineligible", reason: "not_free" };
}
