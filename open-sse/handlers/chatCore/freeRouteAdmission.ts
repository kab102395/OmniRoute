import {
  getCurrentOpenRouterFreeRouteIds,
  getOpenRouterCatalog,
} from "@/lib/catalog/openrouterCatalog";
import {
  getSyncedAvailableModelsByConnection,
  getSyncedAvailableModelsForConnection,
} from "@/lib/db/models";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import { getSyncStatus as getModelsDevSyncStatus } from "@/lib/modelsDevSync";
import { resolveProviderId } from "@/shared/constants/providers";
import { isFreeModel } from "@/shared/utils/freeModels";
import {
  isFreshCatalogTimestamp,
  PROVIDER_ROUTE_CATALOG_MAX_AGE_MS,
} from "@/lib/catalog/metadataFreshness";
import { FREE_MODEL_BUDGETS } from "@omniroute/open-sse/config/freeModelCatalog.ts";
import {
  classifyStrictZeroCostCandidate,
  findBudgetEntry,
} from "@omniroute/open-sse/services/autoCombo/strictZeroCostFilter";
import { refreshAndResolveFreeAccessState } from "@omniroute/open-sse/services/autoCombo/freeAccessQuota";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "@omniroute/open-sse/services/autoCombo/resilienceCandidateFilter";
import type { FreeAccessState } from "@omniroute/open-sse/services/autoCombo/strictZeroCostFilter";

export type FreeRouteAdmission =
  | {
      readonly kind: "eligible";
      readonly source:
        | "openrouter.models_api"
        | "huggingface.router_models_api"
        | "provider_model_catalog"
        | "omniroute.free_model_catalog";
    }
  | { readonly kind: "ineligible"; readonly reason: "catalog_unverified" | "not_free" };

export type ToolCallingRouteAdmission =
  | { readonly kind: "eligible"; readonly source: string }
  | {
      readonly kind: "ineligible";
      readonly reason: "catalog_unverified" | "unsupported" | "unknown";
    };

export type ZeroCostRouteAdmission =
  | { readonly kind: "eligible"; readonly source: string }
  | {
      readonly kind: "ineligible";
      readonly reason:
        | "catalog_unverified"
        | "not_free"
        | "no_hard_stop"
        | "quota_unverified"
        | "quota_exhausted"
        | "no_connection";
    };

function isFreshProviderRouteTimestamp(value: string | null | undefined): boolean {
  const retrievedAt = value ? Date.parse(value) : Number.NaN;
  return (
    Number.isFinite(retrievedAt) &&
    retrievedAt <= Date.now() &&
    Date.now() - retrievedAt <= PROVIDER_ROUTE_CATALOG_MAX_AGE_MS
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
    if (capability.supportsToolsSource === "synced_capability_catalog") {
      const sourceStatus = getModelsDevSyncStatus();
      if (!isFreshCatalogTimestamp(sourceStatus.sourceRetrievedAt)) {
        return { kind: "ineligible", reason: "catalog_unverified" };
      }
    }
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
  model: string,
  connectionId?: string | null
): Promise<FreeRouteAdmission> {
  const canonicalProvider = resolveProviderId(provider);
  if (canonicalProvider === "openrouter") {
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

  if (canonicalProvider === "huggingface") {
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

  // Some provider model endpoints publish an explicit `is_free`/`isFree`
  // fact per exact model. Prefer that connection-scoped, freshly synchronized
  // provider fact over OmniRoute's release-curated fallback. An explicit paid
  // verdict must also prevent a stale curated entry from making the route free.
  const exactModelId = model.replace(/^[^/]+\//, "");
  const syncedRows = connectionId
    ? await getSyncedAvailableModelsForConnection(canonicalProvider, connectionId)
    : Object.values(await getSyncedAvailableModelsByConnection(canonicalProvider)).flat();
  const matchingCatalogRows = syncedRows
    .filter((entry) => entry.id === model || entry.id === exactModelId)
    .filter((entry) => typeof entry.isFree === "boolean")
    .sort((left, right) => {
      const leftRetrievedAt = Date.parse(left.catalogRetrievedAt ?? "");
      const rightRetrievedAt = Date.parse(right.catalogRetrievedAt ?? "");
      return (
        (Number.isFinite(rightRetrievedAt) ? rightRetrievedAt : Number.NEGATIVE_INFINITY) -
        (Number.isFinite(leftRetrievedAt) ? leftRetrievedAt : Number.NEGATIVE_INFINITY)
      );
    });
  const providerCatalogVerdict = matchingCatalogRows[0];
  if (providerCatalogVerdict) {
    if (!isFreshCatalogTimestamp(providerCatalogVerdict.catalogRetrievedAt)) {
      return { kind: "ineligible", reason: "catalog_unverified" };
    }
    return providerCatalogVerdict.isFree
      ? { kind: "eligible", source: "provider_model_catalog" }
      : { kind: "ineligible", reason: "not_free" };
  }

  return isFreeModel(provider, { id: model })
    ? { kind: "eligible", source: "omniroute.free_model_catalog" }
    : { kind: "ineligible", reason: "not_free" };
}

/**
 * Require stronger no-charge evidence than the free catalog classification.
 * Current exact OpenRouter and Hugging Face free-route catalogs are authoritative
 * for their pinned/free routes. Other providers reuse the existing curated
 * hard-stop facts and quota cache used by STRICT_ZERO_COST.
 */
export async function checkZeroCostRouteAdmission(
  provider: string,
  model: string,
  connectionId?: string | null,
  maxStateAgeMs = 180_000,
  dependencies: {
    checkFreeRoute?: typeof checkFreeRouteAdmission;
    resolveQuota?: (provider: string, connectionId: string) => Promise<FreeAccessState | undefined>;
  } = {}
): Promise<ZeroCostRouteAdmission> {
  const canonicalProvider = resolveProviderId(provider);
  const freeAdmission = await (dependencies.checkFreeRoute ?? checkFreeRouteAdmission)(
    provider,
    model,
    connectionId
  );
  if (freeAdmission.kind !== "eligible") {
    return { kind: "ineligible", reason: freeAdmission.reason };
  }

  if (canonicalProvider === "openrouter" || canonicalProvider === "huggingface") {
    return { kind: "eligible", source: freeAdmission.source };
  }

  const providerPrefix = [`${provider}/`, `${canonicalProvider}/`].find((prefix) =>
    model.startsWith(prefix)
  );
  const relativeModelId = providerPrefix ? model.slice(providerPrefix.length) : model;
  let connectionKey = connectionId || undefined;
  const candidate = {
    provider: canonicalProvider,
    model: relativeModelId,
    connectionId: connectionKey ?? null,
  };
  const budget = findBudgetEntry(candidate, FREE_MODEL_BUDGETS);
  if (!budget?.hardStopGuaranteed) {
    return { kind: "ineligible", reason: "no_hard_stop" };
  }
  connectionKey =
    connectionKey || (budget.freeType === "keyless" ? SYNTHETIC_NOAUTH_CONNECTION_ID : undefined);
  if (!connectionKey) return { kind: "ineligible", reason: "no_connection" };
  candidate.connectionId = connectionKey;

  const state =
    connectionKey === SYNTHETIC_NOAUTH_CONNECTION_ID
      ? undefined
      : await (dependencies.resolveQuota ?? refreshAndResolveFreeAccessState)(
          provider,
          connectionKey
        );
  const verdict = classifyStrictZeroCostCandidate(candidate, budget, () => state, {
    minRemainingAllowance: 1,
    maxStateAgeMs,
  });
  if (verdict.outcome === "safe") {
    return { kind: "eligible", source: "provider_model_catalog_and_quota" };
  }
  if (verdict.outcome === "no-hard-stop") {
    return { kind: "ineligible", reason: "no_hard_stop" };
  }
  if (verdict.outcome === "no-connection") {
    return { kind: "ineligible", reason: "no_connection" };
  }
  if (verdict.outcome === "exhausted") {
    return { kind: "ineligible", reason: "quota_exhausted" };
  }
  return { kind: "ineligible", reason: "quota_unverified" };
}
