/**
 * catalogResponse.ts — the tail of the /v1/models build: the post-filter chain and
 * the response envelope.
 *
 * Extracted from catalog.ts so the full catalog build and the quota-exclusive
 * short-circuit share one implementation. Two paths emitting the same envelope by
 * copy would drift; the quota path in particular silently lost the discovery
 * mirrors the first time it was written as a duplicate.
 */

import { appendNoThinkingVariants } from "@omniroute/open-sse/utils/noThinkingAlias";
import { appendClaudeEffortVariants } from "@omniroute/open-sse/utils/claudeEffortVariants";
import { appendSyncedEffortVariants } from "@omniroute/open-sse/utils/syncedEffortVariants";
import { appendCcDiscoveryAliases } from "@omniroute/open-sse/utils/ccDiscoveryAliases";
import {
  appendFunctionalGatewayMirrors,
  isFunctionalGatewayMirror,
} from "@omniroute/open-sse/utils/functionalGatewayMirrors";
import { isCcAliasGlobalEnabled, getCcAliasSettingsBulk } from "@/lib/db/ccDiscoveryAliases";
import { buildCcAliasPredicate } from "./ccAliasPredicate";
import {
  isFunctionalGatewayGlobalEnabled,
  getFunctionalGatewaySettingsBulk,
} from "@/lib/db/functionalGatewayMirrors";
import { buildFunctionalGatewayPredicate } from "./functionalGatewayPredicate";
import { getPassthroughProviders, REGISTRY } from "@omniroute/open-sse/config/providerRegistry";
import { hasEligibleConnectionForModel } from "@/domain/connectionModelRules";
import { dedupeExactCatalogIds } from "./catalogDedupe";
import { sortCatalogModelsProviderGrouped } from "./catalogOrder";
import {
  disambiguateCatalogModelNames,
  enrichCatalogModelEntry,
  type CatalogEnrichmentSnapshot,
} from "@/lib/modelMetadataRegistry";
import { createModelCapabilityResolutionSnapshot } from "@/lib/modelCapabilityResolutionSnapshot";
import {
  isModelCatalogNamesEnabled,
  isNoThinkingAliasEnabled,
  isDisableThinkingLevelVariantsEnabled,
} from "@/shared/utils/featureFlags";
import { extractApiKey } from "@/sse/services/auth";
import { maybeOmitCatalogModelName } from "./catalogHelpers";
import { isCodexModelCatalogClient } from "./catalogRequest";
import { expandHuggingFaceProviderRoutes } from "./catalogProviderRoutes";
import { isFreeOnlyCatalogModel } from "./freeOnlyCatalog";
import type { ModelCatalogEntry, ModelCatalogResponse } from "@/domain/modelCatalogContract";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasVerifiedToolCalling(model: Record<string, unknown>): boolean {
  const capabilityStatus = model.capability_status;
  return (
    isRecord(capabilityStatus) &&
    isRecord(capabilityStatus.tool_calling) &&
    capabilityStatus.tool_calling.status === "supported"
  );
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function preservePinnedHuggingFaceRouteFacts(
  listedModel: Record<string, unknown>,
  sourceModel: Record<string, unknown>
): Record<string, unknown> {
  const routes = sourceModel.provider_routes;
  const routeSelection = sourceModel.route_selection;
  if (
    (sourceModel.owned_by !== "hf" && sourceModel.owned_by !== "huggingface") ||
    typeof sourceModel.id !== "string" ||
    !Array.isArray(routes) ||
    routes.length !== 1 ||
    !isRecord(routes[0]) ||
    routes[0].route_model !== sourceModel.id ||
    !isRecord(routeSelection) ||
    routeSelection.kind !== "exact_model"
  ) {
    return listedModel;
  }

  const route = routes[0];
  const capabilities = isRecord(listedModel.capabilities) ? { ...listedModel.capabilities } : {};
  if (typeof route.supports_tools === "boolean") {
    capabilities.tool_calling = route.supports_tools;
  } else {
    delete capabilities.tool_calling;
  }
  if (typeof route.supports_structured_output === "boolean") {
    capabilities.structured_output = route.supports_structured_output;
  }

  return {
    ...listedModel,
    ...(typeof sourceModel.free === "boolean" ? { free: sourceModel.free } : {}),
    ...(sourceModel.pricing !== undefined ? { pricing: sourceModel.pricing } : {}),
    context_length: positiveFiniteNumber(route.context_length),
    max_output_tokens: undefined,
    capabilities,
    capability_status: {
      ...(isRecord(listedModel.capability_status) ? listedModel.capability_status : {}),
      tool_calling: {
        status:
          route.supports_tools === true
            ? "supported"
            : route.supports_tools === false
              ? "unsupported"
              : "unknown",
        source: "huggingface.router_models_api",
      },
    },
    route_selection: sourceModel.route_selection,
    route_availability: sourceModel.route_availability,
    pricing_provenance: sourceModel.pricing_provenance,
    provider_routes: sourceModel.provider_routes,
    provider_routes_provenance: sourceModel.provider_routes_provenance,
  };
}

/**
 * Post-filter chain applied AFTER the API-key filter, so variants and mirrors are
 * only derived from models the caller may actually see.
 *
 * Shared by the full build and by the quota-exclusive short-circuit: the quota path
 * returns early, but it still owes the caller these steps — the discovery mirrors in
 * particular are what let Claude Code see a quota pool's models at all.
 */
export async function applyCatalogPostFilters(
  request: Request,
  models: ModelCatalogEntry[],
  ctx: {
    connections: Array<{ provider: string; providerSpecificData: unknown }>;
    prefixMode: string;
    aliasToProviderId: Record<string, string>;
    providerNodeIdByPrefix?: Record<string, string>;
    hideNoThinkVariants?: boolean;
  }
): Promise<ModelCatalogEntry[]> {
  const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  let finalModels = models;

  // variants are only generated for surviving models.
  if (new URL(request.url).searchParams.get("configuredOnly") === "true") {
    finalModels = finalModels.filter((m) => {
      if (!m.root) return true;
      if (m.owned_by === "combo") return hasEligibleConnectionForModel(ctx.connections, m.root);
      const owner = typeof m.owned_by === "string" ? m.owned_by : "";
      const providerId =
        ctx.aliasToProviderId[owner] || ctx.providerNodeIdByPrefix?.[owner] || owner;
      const providerConnections = ctx.connections.filter((connection) => {
        const connectionProviderId =
          ctx.aliasToProviderId[connection.provider] || connection.provider;
        return connection.provider === owner || connectionProviderId === providerId;
      });
      return hasEligibleConnectionForModel(providerConnections, m.root);
    });
  }

  // #9147: the variant-append passes each walk the full model list (O(n) per pass),
  // so a catalog-scale build must not run all of them in one synchronous stretch.
  // Yield once between the expensive passes to let the event loop breathe.
  await yieldTurn();

  // Advertise Claude reasoning-effort variants (claude/<model>-{low,medium,high[,xhigh]}).
  // Derived from the already key-filtered list so a variant only appears when its real
  // model is permitted. Runs before the no-thinking pass: the gateway already routes these
  // suffixed ids (claudeEffortVariant.ts), this just makes them selectable in catalog-only
  // clients (OpenCode) that can't set a reasoning_effort config the way VS Code does.
  finalModels = appendClaudeEffortVariants(
    finalModels,
    ctx.prefixMode === "canonical" ? ctx.aliasToProviderId : undefined
  );

  // Advertise no-thinking gateway variants (Fase 8.1). Derived from the already
  // key-filtered list, so a variant only appears when its real model is permitted.
  // #9418: skip when hideNoThinkVariants is on — the ids are still routable when
  // sent explicitly, just not advertised in the catalog. The NO_THINKING_ALIAS_ENABLED
  // feature flag is the stronger switch: it also stops the ids from routing (see
  // src/sse/handlers/chat.ts), so nothing is advertised when it is off. Resolved once
  // here and injected, keeping the open-sse helper I/O-free (one flag read per catalog
  // build, not one per model).
  if (!ctx.hideNoThinkVariants) {
    finalModels = appendNoThinkingVariants(
      finalModels,
      ctx.prefixMode === "canonical" ? ctx.aliasToProviderId : undefined,
      { featureEnabled: isNoThinkingAliasEnabled() }
    );
  }

  // Advertise `claude/<id>` discovery-mirror aliases so Claude Code's gateway
  // model discovery (which only lists `claude`/`anthropic`-prefixed ids) can see
  // every model this gate allows. Gated 3 levels deep (global > provider > model,
  // see ccDiscoveryAliases.ts) and default-off. Deliberately NOT filtered by model
  // `type` here — non-chat entries (embedding/image/etc.) get a mirror too; the
  // gate itself (default-off + explicit opt-in) is the operator's filter, not a
  // hardcoded type allowlist.
  const ccAliasGlobal = isCcAliasGlobalEnabled();
  const ccAliasSettings = getCcAliasSettingsBulk();
  if (ccAliasGlobal || ccAliasSettings.providers.size > 0 || ccAliasSettings.models.size > 0) {
    finalModels = appendCcDiscoveryAliases(
      finalModels,
      buildCcAliasPredicate({
        global: ccAliasGlobal,
        providers: ccAliasSettings.providers,
        models: ccAliasSettings.models,
      })
    );
  }

  // Advertise `<gateway-alias>/<id>` functional-gateway mirrors so discovery
  // clients surface the route that actually has a credential, even when the
  // canonical owner provider has none (e.g. `deepseek/deepseek-v4-flash` fails
  // 404 but `agentrouter/deepseek/deepseek-v4-flash` returns 200). Gated 3
  // levels deep (global > provider > model, see db/functionalGatewayMirrors.ts)
  // and default-off. Only emits a mirror when the canonical owner has no
  // eligible connection for the model AND a passthrough gateway with an active
  // credential covers it.
  const fgGlobal = isFunctionalGatewayGlobalEnabled();
  const fgSettings = getFunctionalGatewaySettingsBulk();
  if (fgGlobal || fgSettings.providers.size > 0 || fgSettings.models.size > 0) {
    const gatewayProviderIds = [...getPassthroughProviders()];
    finalModels = appendFunctionalGatewayMirrors(finalModels, {
      gatewayProviderIds,
      isGateway: (provider) => getPassthroughProviders().has(provider),
      gatewayAlias: (provider) => REGISTRY[provider]?.alias || provider,
      gatewayCovers: (provider, modelId) =>
        hasEligibleConnectionForModel(
          ctx.connections.filter((c) => c.provider === provider),
          modelId
        ),
      gatewayHasConnection: (provider) => ctx.connections.some((c) => c.provider === provider),
      canonicalOwnerHasConnection: (owner) =>
        hasEligibleConnectionForModel(
          ctx.connections.filter((c) => c.provider === owner),
          owner
        ),
    });
    finalModels = finalModels.filter((m) =>
      buildFunctionalGatewayPredicate({ global: fgGlobal, ...fgSettings })(m)
    );
  }

  await yieldTurn();

  // #7694: advertise `<provider>/<model>-<tier>` variants for synced models that
  // captured `reasoning.supported_efforts` at sync time (capabilities.effort_tiers).
  // Derived from the already key-filtered list; skips codex/kimi (own suffix mechanism).
  if (!isDisableThinkingLevelVariantsEnabled()) {
    finalModels = appendSyncedEffortVariants(finalModels);
  }

  await yieldTurn();

  // #4424 follow-up — drop exact-duplicate ids that slip through the per-source push
  // guards (e.g. `codex/gpt-5.5`, `veo-free/seedance` listed twice). Keyed by listing
  // identity (id, type, subtype) so the intentional same-id audio transcription/speech
  // pair survives. Independent of MODELS_CATALOG_PREFIX_MODE; runs as the final guard.
  finalModels = dedupeExactCatalogIds(finalModels);

  return finalModels;
}

/**
 * Functional-gateway mirrors remain gateway-prefixed through request-time policy
 * enforcement, so they must authorize that final public ID. Other synthetic IDs
 * are normalized back to their base model before policy enforcement and keep the
 * base model's permission by design.
 */
export async function filterUnauthorizedFunctionalGatewayMirrors(
  models: Array<Record<string, unknown>>,
  apiKey: string,
  isModelAllowed: (key: string, modelId: string) => Promise<boolean>
): Promise<Array<Record<string, unknown>>> {
  const filtered: Array<Record<string, unknown>> = [];
  for (const model of models) {
    if (!isFunctionalGatewayMirror(model)) {
      filtered.push(model);
      continue;
    }

    if (typeof model.id === "string" && (await isModelAllowed(apiKey, model.id))) {
      filtered.push(model);
    }
  }
  return filtered;
}

/**
 * Enrich the selected models and serialise the catalog response.
 *
 * Shared by the full build and by the quota-exclusive short-circuit so both emit a
 * byte-identical envelope. `getContextFallback` supplies the registry default
 * context length for non-combo entries; the quota path passes a no-op because its
 * entries are all `owned_by: "combo"`, which skips enrichment entirely.
 */
export async function finalizeCatalogResponse(
  request: Request,
  finalModels: ModelCatalogEntry[],
  getContextFallback: (model: Record<string, unknown>) => number | undefined,
  headers: Record<string, string>,
  enrichmentSnapshot?: CatalogEnrichmentSnapshot
): Promise<Response> {
  const apiKey = extractApiKey(request);
  if (apiKey) {
    const { getApiKeyMetadata, isModelAllowedForKey } = await import("@/lib/db/apiKeys");
    const keyMeta = await getApiKeyMetadata(apiKey);
    if (keyMeta && keyMeta.id !== "env-key" && !keyMeta.allowedQuotas?.length) {
      finalModels = await filterUnauthorizedFunctionalGatewayMirrors(
        finalModels,
        apiKey,
        isModelAllowedForKey
      );
    }
  }

  const includeModelNames = isModelCatalogNamesEnabled();
  const query = new URL(request.url).searchParams;
  const freeOnly = query.get("free_only") === "true";
  const requireToolCalling = query.get("require_tool_calling") === "true";
  // #9147: enrichment is the most expensive single stage of the catalog build —
  // per-entry provider/model resolution plus pricing + token/context override
  // lookups. Two fixes so a large catalog cannot pin the Node.js thread here:
  //  (1) bulk-load the synced-capability + override tables ONCE into an in-memory
  //      snapshot (#9199 machinery) so per-entry enrichment never hits SQLite;
  //  (2) yield to the event loop every `YIELD_EVERY` entries so even the remaining
  //      per-entry work is interleaved with other callers / the dashboard WS.
  const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  await yieldTurn();
  const capabilityResolutionSnapshot =
    enrichmentSnapshot?.capabilityResolutionSnapshot ?? createModelCapabilityResolutionSnapshot();
  const enriched: Array<Record<string, unknown>> = [];
  const catYIELD_EVERY = 5;
  let catEnrichCount = 0;
  for (const model of finalModels) {
    let listedModel: Record<string, unknown>;
    if (model.owned_by === "combo") {
      listedModel = maybeOmitCatalogModelName(model, includeModelNames);
    } else {
      const entry = enrichCatalogModelEntry(model, undefined, {
        ...enrichmentSnapshot,
        capabilityResolutionSnapshot,
      });
      const fallbackContextLength = getContextFallback(entry);
      listedModel = fallbackContextLength
        ? { ...entry, context_length: fallbackContextLength }
        : entry;
      listedModel = maybeOmitCatalogModelName(listedModel, includeModelNames);
    }
    if (
      isRecord(listedModel.capabilities) &&
      isRecord(listedModel.capability_status) &&
      isRecord(listedModel.capability_status.tool_calling) &&
      listedModel.capability_status.tool_calling.status === "unknown"
    ) {
      const capabilities = { ...listedModel.capabilities };
      delete capabilities.tool_calling;
      listedModel = { ...listedModel, capabilities };
    }
    listedModel = preservePinnedHuggingFaceRouteFacts(listedModel, model);
    enriched.push(listedModel);
    catEnrichCount++;
    if (catEnrichCount % catYIELD_EVERY === 0) {
      await yieldTurn();
    }
  }
  await yieldTurn();
  const routeCandidates = expandHuggingFaceProviderRoutes(enriched, {
    freeOnly: false,
    requireToolCalling,
  });
  const capabilityFilteredCandidates = requireToolCalling
    ? routeCandidates.filter(hasVerifiedToolCalling)
    : routeCandidates;
  const filteredCandidates = freeOnly
    ? capabilityFilteredCandidates.filter(isFreeOnlyCatalogModel)
    : capabilityFilteredCandidates;
  const enrichedModels = disambiguateCatalogModelNames(filteredCandidates);
  await yieldTurn();
  const orderedModels = sortCatalogModelsProviderGrouped(enrichedModels);
  await yieldTurn();
  // Codex CLI compatibility: its model-catalog refresh (codex_models_manager) does
  // GET /v1/models?client_version=<v> and decodes a JSON object with a TOP-LEVEL
  // `models` array, so the OpenAI-standard `{object,data}` shape makes it fail with
  // "missing field `models`" and log "failed to refresh available models" on every
  // startup. For codex clients only (detected by the codex originator/user-agent) we add
  // an EMPTY `models: []` so the decode succeeds and the error disappears. Every other
  // OpenAI consumer keeps the byte-identical `{object,data}` response.
  //
  // We deliberately keep it EMPTY rather than mirroring the catalog: codex replaces its
  // built-in per-model agent prompt (`base_instructions`, ~21k chars) with whatever a
  // populated entry carries for the selected model, so emitting our models with an
  // empty/foreign `base_instructions` would drop codex's agent prompt to nothing and
  // break its agent behavior (verified empirically against codex 0.137). An empty array
  // keeps codex on its built-in model info — same inference as today, minus the error.
  const responseBody: ModelCatalogResponse = {
    object: "list",
    data: orderedModels,
  };
  if (isCodexModelCatalogClient(request)) {
    responseBody.models = [];
  }

  return Response.json(responseBody, { headers });
}
