type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Materialize Hugging Face's provider-pinned subroutes when a consumer asks for
 * constrained candidates. The ordinary catalog keeps its existing aggregate
 * row; this projection gives exact-route clients a selectable model id.
 */
export function expandHuggingFaceProviderRoutes(
  models: Array<JsonRecord>,
  options: { freeOnly: boolean; requireToolCalling: boolean }
): Array<JsonRecord> {
  if (!options.freeOnly && !options.requireToolCalling) return models;

  const expanded = [...models];
  for (const model of models) {
    if (model.owned_by !== "huggingface" && model.owned_by !== "hf") continue;
    if (typeof model.id !== "string" || !Array.isArray(model.provider_routes)) continue;

    const provenance = isRecord(model.provider_routes_provenance)
      ? model.provider_routes_provenance
      : null;
    if (provenance?.source !== "huggingface.router_models_api") continue;
    const retrievedAt =
      typeof provenance.retrieved_at === "string" ? provenance.retrieved_at : null;
    const stale = provenance.stale !== false;

    for (const rawRoute of model.provider_routes) {
      if (!isRecord(rawRoute) || rawRoute.status !== "live") continue;
      const routeModel = typeof rawRoute.route_model === "string" ? rawRoute.route_model : null;
      const provider = typeof rawRoute.provider === "string" ? rawRoute.provider : null;
      if (!routeModel || !provider || !routeModel.startsWith(`${model.id}:`)) continue;
      if (options.freeOnly && (stale || rawRoute.free_catalog_eligible !== true)) continue;
      if (options.requireToolCalling && rawRoute.supports_tools !== true) continue;

      const routeId = routeModel.replace(/^(?:hf|huggingface)\//, "");
      const capabilities = isRecord(model.capabilities) ? { ...model.capabilities } : {};
      if (typeof rawRoute.supports_tools === "boolean") {
        capabilities.tool_calling = rawRoute.supports_tools;
      } else {
        delete capabilities.tool_calling;
      }
      if (typeof rawRoute.supports_structured_output === "boolean") {
        capabilities.structured_output = rawRoute.supports_structured_output;
      }

      const isCurrentFree = !stale && rawRoute.free_catalog_eligible === true;
      const pricing = isRecord(rawRoute.pricing) ? rawRoute.pricing : undefined;
      const routePricingState = isCurrentFree
        ? "free_variant"
        : pricing
          ? "reported"
          : "unavailable";
      const routePricing = {
        state: routePricingState,
        routeModelId: routeModel,
        currency: "USD",
        tokenRateUnit: "USD / 1M tokens",
        reportedPricing: pricing ?? null,
        zeroCostEligibility: isCurrentFree ? "verified_free_variant" : "no",
        downstreamHost: { selection: "pinned", provider },
        source: {
          id: "huggingface.router_models_api",
          modelId: routeModel,
          retrievedAt,
          stale,
          cacheTtlMs: 15 * 60 * 1000,
        },
      };

      expanded.push({
        ...model,
        id: routeModel,
        root: routeId,
        name: `${typeof model.name === "string" ? model.name : model.id} · ${provider}`,
        pricing: pricing ?? model.pricing,
        // A pinned host can impose a smaller context limit than the aggregate
        // model row. Never carry the aggregate fallback into an exact route when
        // the host did not publish its own limit.
        context_length: positiveFiniteNumber(rawRoute.context_length),
        // Hugging Face's provider mapping does not currently supply a host-level
        // output limit. Preserve that uncertainty instead of inheriting a
        // model-family fallback from the aggregate catalog row.
        max_output_tokens: undefined,
        capabilities,
        capability_status: {
          ...(isRecord(model.capability_status) ? model.capability_status : {}),
          tool_calling: {
            status:
              rawRoute.supports_tools === true
                ? "supported"
                : rawRoute.supports_tools === false
                  ? "unsupported"
                  : "unknown",
            source: "huggingface.router_models_api",
          },
        },
        free: isCurrentFree,
        route_selection: { kind: "exact_model", exactModelIdentity: true },
        route_availability: {
          catalogListed: rawRoute.status === "live",
          accountEligibility: "unknown",
          source: {
            id: "huggingface.router_models_api",
            modelId: routeModel,
            retrievedAt,
            stale,
            cacheTtlMs: 15 * 60 * 1000,
          },
          downstreamHostSelection: "pinned",
        },
        pricing_provenance: routePricing,
        provider_routes: [rawRoute],
        provider_routes_provenance: provenance,
      });
    }
  }
  return expanded;
}
