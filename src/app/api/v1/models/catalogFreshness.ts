import {
  PROVIDER_ROUTE_CATALOG_MAX_AGE_MS,
  SYNCED_MODEL_CATALOG_MAX_AGE_MS,
} from "@/lib/catalog/metadataFreshness";

type UnknownRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freshnessRemainingMs(source: UnknownRecord, maxAgeMs: number, now: number): number | null {
  if (source.stale !== false) return 0;
  const retrievedAt =
    typeof source.retrievedAt === "string"
      ? source.retrievedAt
      : typeof source.retrieved_at === "string"
        ? source.retrieved_at
        : null;
  const retrievedAtMs = retrievedAt ? Date.parse(retrievedAt) : Number.NaN;
  if (!Number.isFinite(retrievedAtMs) || retrievedAtMs > now) return 0;
  const configuredMaxAge = source.cacheTtlMs;
  const ageLimit =
    typeof configuredMaxAge === "number" &&
    Number.isFinite(configuredMaxAge) &&
    configuredMaxAge > 0
      ? Math.min(maxAgeMs, configuredMaxAge)
      : maxAgeMs;
  return Math.max(0, ageLimit - (now - retrievedAtMs));
}

/**
 * Keep constrained model-list cache entries no fresher than the source facts
 * that made their free or tool-capable routes eligible. Unconstrained catalog
 * responses retain the ordinary short cache window.
 */
export function boundRoutingCatalogCacheTtl(
  body: string,
  requestUrl: string,
  configuredTtlMs: number,
  now = Date.now()
): number {
  const query = new URL(requestUrl).searchParams;
  const freeOnly = query.get("free_only") === "true";
  const requireToolCalling = query.get("require_tool_calling") === "true";
  if (!freeOnly && !requireToolCalling) return configuredTtlMs;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return configuredTtlMs;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) return configuredTtlMs;

  let ttlMs = configuredTtlMs;
  for (const model of parsed.data) {
    if (!isRecord(model)) continue;

    if (freeOnly && model.free === true) {
      if (model.owned_by === "openrouter") {
        const availability = isRecord(model.route_availability) ? model.route_availability : null;
        const source = availability && isRecord(availability.source) ? availability.source : null;
        if (source?.id === "openrouter.models_api") {
          ttlMs = Math.min(
            ttlMs,
            freshnessRemainingMs(source, PROVIDER_ROUTE_CATALOG_MAX_AGE_MS, now) ?? 0
          );
        }
      }

      const freeProvenance = isRecord(model.free_route_provenance)
        ? model.free_route_provenance
        : null;
      const freeSource =
        freeProvenance && isRecord(freeProvenance.source) ? freeProvenance.source : null;
      if (freeSource?.id === "provider_model_catalog") {
        ttlMs = Math.min(
          ttlMs,
          freshnessRemainingMs(freeSource, SYNCED_MODEL_CATALOG_MAX_AGE_MS, now) ?? 0
        );
      }

      const routeProvenance = isRecord(model.provider_routes_provenance)
        ? model.provider_routes_provenance
        : null;
      if (routeProvenance?.source === "huggingface.router_models_api") {
        ttlMs = Math.min(
          ttlMs,
          freshnessRemainingMs(routeProvenance, PROVIDER_ROUTE_CATALOG_MAX_AGE_MS, now) ?? 0
        );
      }
    }

    if (requireToolCalling) {
      const capabilityStatus = isRecord(model.capability_status) ? model.capability_status : null;
      const toolCalling =
        capabilityStatus && isRecord(capabilityStatus.tool_calling)
          ? capabilityStatus.tool_calling
          : null;
      if (toolCalling && toolCalling.status === "supported") {
        const source = toolCalling.source;
        const maxAgeMs =
          source === "huggingface.router_models_api" || source === "openrouter.models_api"
            ? PROVIDER_ROUTE_CATALOG_MAX_AGE_MS
            : source === "synced_capability_catalog" || source === "provider_model_catalog"
              ? SYNCED_MODEL_CATALOG_MAX_AGE_MS
              : null;
        if (maxAgeMs !== null) {
          ttlMs = Math.min(ttlMs, freshnessRemainingMs(toolCalling, maxAgeMs, now) ?? 0);
        }
      }
    }
  }
  return ttlMs;
}
