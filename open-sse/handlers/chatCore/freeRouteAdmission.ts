import {
  getCurrentOpenRouterFreeRouteIds,
  getOpenRouterCatalog,
} from "@/lib/catalog/openrouterCatalog";
import {
  getSyncedAvailableModelsByConnection,
  getSyncedAvailableModelsForConnection,
} from "@/lib/db/models";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import { resolveProviderId } from "@/shared/constants/providers";
import { isFreeModel } from "@/shared/utils/freeModels";
import { isFreshCatalogTimestamp } from "@/lib/catalog/metadataFreshness";

export type FreeRouteAdmission =
  | {
      readonly kind: "eligible";
      readonly source:
        "openrouter.models_api" | "huggingface.router_models_api" | "omniroute.free_model_catalog";
    }
  | { readonly kind: "ineligible"; readonly reason: "catalog_unverified" | "not_free" };

export type ToolCallingRouteAdmission =
  | { readonly kind: "eligible"; readonly source: string }
  | {
      readonly kind: "ineligible";
      readonly reason: "catalog_unverified" | "unsupported" | "unknown";
    };

const PROVIDER_ROUTE_FRESHNESS_MS = 15 * 60 * 1000;

function isFreshProviderRouteTimestamp(value: string | null | undefined): boolean {
  const retrievedAt = value ? Date.parse(value) : Number.NaN;
  return (
    Number.isFinite(retrievedAt) &&
    retrievedAt <= Date.now() &&
    Date.now() - retrievedAt <= PROVIDER_ROUTE_FRESHNESS_MS
  );
}

/** Check tool support against metadata for the exact selected route at dispatch time. */
export async function checkToolCallingRouteAdmission(
  provider: string,
  model: string,
  connectionId?: string | null
): Promise<ToolCallingRouteAdmission> {
  const canonicalProvider = resolveProviderId(provider);
  if (canonicalProvider === "openrouter") {
    const catalog = await getOpenRouterCatalog();
    if (catalog.stale) return { kind: "ineligible", reason: "catalog_unverified" };

    const exactRouteId = model.replace(/^openrouter\//, "");
    if (exactRouteId === "free") return { kind: "ineligible", reason: "unknown" };
    const route = catalog.data.find((entry) => entry.id === exactRouteId);
    if (!route) return { kind: "ineligible", reason: "unsupported" };
    if (!Array.isArray(route.supported_parameters)) {
      return { kind: "ineligible", reason: "unknown" };
    }
    return route.supported_parameters.includes("tools")
      ? { kind: "eligible", source: "openrouter.models_api" }
      : { kind: "ineligible", reason: "unsupported" };
  }

  if (canonicalProvider === "huggingface") {
    const separator = model.lastIndexOf(":");
    if (separator > 0 && separator < model.length - 1) {
      const baseModelId = model.slice(0, separator).replace(/^(?:hf|huggingface)\//, "");
      const providerRoute = model.slice(separator + 1);
      const byConnection = await getSyncedAvailableModelsByConnection("huggingface");
      const matchingModels = Object.values(byConnection)
        .flat()
        .filter((entry) => entry.id === baseModelId)
        .sort((left, right) => {
          const leftTime = Date.parse(left.providerRoutesRetrievedAt ?? "");
          const rightTime = Date.parse(right.providerRoutesRetrievedAt ?? "");
          return rightTime - leftTime;
        });
      const routeCatalog = matchingModels[0];
      if (!isFreshProviderRouteTimestamp(routeCatalog?.providerRoutesRetrievedAt)) {
        return { kind: "ineligible", reason: "catalog_unverified" };
      }
      const route = routeCatalog?.providerRoutes?.find((entry) => entry.provider === providerRoute);
      if (route?.status !== "live") return { kind: "ineligible", reason: "unsupported" };
      if (route.supportsTools === true) {
        return { kind: "eligible", source: "huggingface.router_models_api" };
      }
      return {
        kind: "ineligible",
        reason: route.supportsTools === false ? "unsupported" : "unknown",
      };
    }
  }

  // Provider model discovery is connection-scoped. Prefer an exact capability
  // verdict from the selected account before falling back to global model.dev,
  // registry, or model-spec metadata; another account's discovery must not be
  // treated as evidence for this route.
  if (connectionId) {
    const syncedModels = await getSyncedAvailableModelsForConnection(
      canonicalProvider,
      connectionId
    );
    const exactModelId = model.replace(/^[^/]+\//, "");
    const syncedModel = syncedModels.find(
      (entry) => entry.id === model || entry.id === exactModelId
    );
    if (typeof syncedModel?.supportsTools === "boolean") {
      if (!isFreshCatalogTimestamp(syncedModel.catalogRetrievedAt)) {
        return { kind: "ineligible", reason: "catalog_unverified" };
      }
      return syncedModel.supportsTools
        ? { kind: "eligible", source: "provider_model_catalog" }
        : { kind: "ineligible", reason: "unsupported" };
    }
  }

  const capability = getResolvedModelCapabilities({ provider: canonicalProvider, model });
  if (capability.supportsTools === true) {
    return { kind: "eligible", source: capability.supportsToolsSource };
  }
  return {
    kind: "ineligible",
    reason: capability.supportsTools === false ? "unsupported" : "unknown",
  };
}

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
