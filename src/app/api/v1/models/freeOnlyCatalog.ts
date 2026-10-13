import {
  isFreshCatalogTimestamp,
  PROVIDER_ROUTE_CATALOG_MAX_AGE_MS,
} from "@/lib/catalog/metadataFreshness";

/** Return true for an exact current free route or OpenRouter's dynamic free router. */
export function isExplicitOpenRouterFreeCatalogModel(model: Record<string, unknown>): boolean {
  const availability = isRecord(model.route_availability) ? model.route_availability : null;
  const source = availability && isRecord(availability.source) ? availability.source : null;
  const retrievedAt =
    source && typeof source.retrievedAt === "string" ? Date.parse(source.retrievedAt) : Number.NaN;
  const cacheTtlMs = source?.cacheTtlMs;
  return (
    typeof model.id === "string" &&
    model.id.startsWith("openrouter/") &&
    model.owned_by === "openrouter" &&
    model.free === true &&
    source?.id === "openrouter.models_api" &&
    source.stale === false &&
    Number.isFinite(retrievedAt) &&
    retrievedAt <= Date.now() &&
    typeof cacheTtlMs === "number" &&
    Number.isFinite(cacheTtlMs) &&
    cacheTtlMs > 0 &&
    Date.now() - retrievedAt < cacheTtlMs
  );
}

type UnknownRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep only exact routes with current free-route evidence. Provider catalog membership is
 * sufficient for free-route eligibility; quota exhaustion guarantees remain separate facts
 * in `free_access` and pricing metadata.
 */
export function isFreeOnlyCatalogModel(model: Record<string, unknown>): boolean {
  if (isExplicitOpenRouterFreeCatalogModel(model)) return true;
  if (isFreshProviderCatalogFreeRoute(model)) return true;
  if (
    (model.owned_by === "huggingface" || model.owned_by === "hf") &&
    typeof model.id === "string" &&
    model.free === true &&
    isExactCurrentHuggingFaceFreeRoute(model)
  ) {
    return true;
  }
  if (
    typeof model.id !== "string" ||
    typeof model.root !== "string" ||
    typeof model.owned_by !== "string" ||
    model.owned_by === "combo" ||
    model.custom === true
  ) {
    return false;
  }

  const freeAccess = model.free_access;
  if (!isRecord(freeAccess)) return false;
  const facts = freeAccess;
  const source = facts.source;
  return (
    facts.classification === "documented_free_tier" &&
    facts.hardStopGuaranteed === true &&
    facts.zeroCostOnExhaustion === "provider_hard_stop" &&
    isRecord(source) &&
    source.id === "omniroute.free_model_catalog"
  );
}

function isFreshProviderCatalogFreeRoute(model: Record<string, unknown>): boolean {
  const provenance = model.free_route_provenance;
  const provenanceRecord = isRecord(provenance) ? provenance : null;
  const source =
    provenanceRecord && isRecord(provenanceRecord.source) ? provenanceRecord.source : null;
  return (
    model.free === true &&
    model.custom !== true &&
    typeof model.id === "string" &&
    typeof model.root === "string" &&
    typeof model.owned_by === "string" &&
    model.owned_by !== "combo" &&
    provenanceRecord?.classification === "free" &&
    source?.id === "provider_model_catalog" &&
    source.stale === false &&
    typeof source.modelId === "string" &&
    source.modelId === model.root &&
    isFreshCatalogTimestamp(typeof source.retrievedAt === "string" ? source.retrievedAt : null)
  );
}

function isExactCurrentHuggingFaceFreeRoute(model: Record<string, unknown>): boolean {
  const routeSelection = model.route_selection;
  const provenance = model.provider_routes_provenance;
  const routes = model.provider_routes;
  if (
    !isRecord(routeSelection) ||
    routeSelection.kind !== "exact_model" ||
    routeSelection.exactModelIdentity !== true ||
    !isRecord(provenance) ||
    provenance.source !== "huggingface.router_models_api" ||
    provenance.stale !== false ||
    !isFreshProviderRouteTimestamp(
      typeof provenance.retrieved_at === "string" ? provenance.retrieved_at : null
    ) ||
    !Array.isArray(routes) ||
    routes.length !== 1
  ) {
    return false;
  }
  const route = routes[0];
  return (
    isRecord(route) &&
    route.status === "live" &&
    route.free_catalog_eligible === true &&
    route.route_model === model.id
  );
}

function isFreshProviderRouteTimestamp(value: string | null): boolean {
  const retrievedAt = value ? Date.parse(value) : Number.NaN;
  return (
    Number.isFinite(retrievedAt) &&
    retrievedAt <= Date.now() &&
    Date.now() - retrievedAt <= PROVIDER_ROUTE_CATALOG_MAX_AGE_MS
  );
}
