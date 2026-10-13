import {
  isOpenRouterFreeRoute,
  isOpenRouterZeroPriceRoute,
  type OpenRouterPricing,
} from "@/lib/catalog/openrouterCatalog";
import type { ModelPricingProvenanceState } from "@/domain/modelCatalogContract";

// OpenRouter-specific catalog normalization helpers. Extracted verbatim from
// ./catalog.ts as a cohesive leaf — id qualification, modality normalization,
// model-type inference, and the free-model / display-name heuristics that shape
// OpenRouter entries in `getUnifiedModelsResponse`.

export function qualifyOpenRouterModelId(modelId: string): string {
  return modelId.startsWith("openrouter/") ? modelId : `openrouter/${modelId}`;
}

export function normalizeOpenRouterModalities(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

export function getOpenRouterModelType(_inputModalities: string[], outputModalities: string[]) {
  if (outputModalities.includes("image")) return "image";
  if (outputModalities.includes("audio")) return "audio";
  if (outputModalities.includes("video")) return "video";
  if (outputModalities.includes("embedding")) return "embedding";
  return "chat";
}

export function isZeroPrice(value: unknown) {
  if (typeof value === "number") return value === 0;
  if (typeof value !== "string" || !/^\+?0(?:\.0+)?$/.test(value)) return false;
  return true;
}

export function isOpenRouterFreeModel(model: { id?: string; pricing?: OpenRouterPricing }) {
  // Exact `:free` variants are OpenRouter's provider-classified free routes;
  // complete explicit zero rates are also authoritative for that exact route.
  // A sibling route never inherits another route's free classification.
  if (typeof model.id === "string" && isOpenRouterFreeRoute(model.id)) return true;
  return isOpenRouterZeroPriceRoute(model);
}

export function getOpenRouterDisplayName(model: {
  id?: string;
  name?: string;
  pricing?: OpenRouterPricing;
}) {
  const name = model.name || model.id || "OpenRouter model";
  return isOpenRouterFreeModel(model) && !/\bgr[aá]tis\b/i.test(name) ? `${name} (Grátis)` : name;
}

export function getOpenRouterModelCapabilities(model: {
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {};
  if (Array.isArray(model.architecture?.input_modalities)) {
    capabilities.vision = model.architecture.input_modalities.includes("image");
  }
  if (Array.isArray(model.supported_parameters)) {
    capabilities.tool_calling = model.supported_parameters.includes("tools");
    capabilities.reasoning =
      model.supported_parameters.includes("reasoning") ||
      model.supported_parameters.includes("include_reasoning");
    capabilities.structured_output =
      model.supported_parameters.includes("structured_outputs") ||
      model.supported_parameters.includes("response_format");
  }
  return capabilities;
}

/**
 * Synchronized rows can outlive the live free-route listing. Retain the row for
 * display when allowed, but never retain current free eligibility based only
 * on its older synchronized metadata.
 */
export function reconcileOpenRouterFreeRoutes<T extends Record<string, unknown>>(
  models: T[],
  currentRouteIds: ReadonlySet<string>,
  options: { stale: boolean; retrievedAt: string; ttlMs: number; hidePaid: boolean }
): T[] {
  const result: T[] = [];
  for (const model of models) {
    const id = typeof model.id === "string" ? model.id : "";
    const sourceModelId = id.replace(/^openrouter\//, "");
    const provenance = model.pricing_provenance;
    const hasFreeProvenance =
      provenance !== null &&
      typeof provenance === "object" &&
      (provenance as { state?: unknown }).state === "free_variant";
    const isOpenRouterFreeRow =
      model.owned_by === "openrouter" &&
      (isOpenRouterFreeModel({ id }) || model.free === true || hasFreeProvenance);
    const isCurrentFreeRoute = currentRouteIds.has(id) || currentRouteIds.has(sourceModelId);
    if (!isOpenRouterFreeRow || (!options.stale && isCurrentFreeRoute)) {
      result.push(model);
      continue;
    }
    if (options.hidePaid) continue;

    const oldPricing = model.pricing_provenance;
    const oldLegacyPricing = model.pricing;
    const hadZeroLegacyPricing =
      oldLegacyPricing !== null &&
      typeof oldLegacyPricing === "object" &&
      (oldLegacyPricing as { input?: unknown }).input === 0 &&
      (oldLegacyPricing as { output?: unknown }).output === 0;
    const wasCatalogFree =
      oldPricing !== null &&
      typeof oldPricing === "object" &&
      ((oldPricing as { state?: unknown }).state === "free_variant" ||
        (oldPricing as { zeroCostEligibility?: unknown }).zeroCostEligibility ===
          "verified_free_variant");
    const reconciled = {
      ...model,
      free: options.stale ? undefined : false,
      route_availability: {
        catalogListed: options.stale ? null : false,
        accountEligibility: "unknown",
        source: {
          id: "openrouter.models_api",
          modelId: sourceModelId,
          retrievedAt: options.retrievedAt || null,
          stale: options.stale,
          cacheTtlMs: options.ttlMs,
        },
        downstreamHostSelection: "aggregator_selected",
      },
      pricing_provenance: {
        state: options.stale ? "unknown_stale_catalog" : "not_in_current_free_catalog",
        routeModelId: sourceModelId,
        source: {
          id: "openrouter.models_api",
          modelId: sourceModelId,
          url: "https://openrouter.ai/api/v1/models",
          retrievedAt: options.retrievedAt,
          stale: options.stale,
          cacheTtlMs: options.ttlMs,
        },
        zeroCostEligibility: options.stale ? "unknown_stale_catalog" : "no",
      },
    } as T;
    if (wasCatalogFree || hadZeroLegacyPricing || model.free === true) {
      delete (reconciled as Record<string, unknown>).pricing;
    }
    result.push(reconciled);
  }
  return result;
}

type OpenRouterReportedPricing = OpenRouterPricing;

function parseReportedRate(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  return value;
}

/**
 * Preserve OpenRouter's exact catalog rates and their source context. Its public
 * model catalog reports prompt/completion rates per token but does not pin the
 * downstream host, so this evidence must not be interpreted as a cost ceiling.
 */
export function buildOpenRouterPricingEvidence(
  model: { id: string; pricing?: OpenRouterReportedPricing },
  options: { retrievedAt: string; stale: boolean; ttlMs: number }
) {
  const reportedRates = {
    inputPerTokenUsd: model.pricing?.prompt,
    outputPerTokenUsd: model.pricing?.completion,
    imageReportedUsd: model.pricing?.image,
    imageOutputReportedUsd: model.pricing?.image_output,
    imageTokenReportedUsd: model.pricing?.image_token,
    requestReportedUsd: model.pricing?.request,
    audioInputPerTokenUsd: model.pricing?.audio,
    audioOutputPerTokenUsd: model.pricing?.audio_output,
    inputAudioCachePerTokenUsd: model.pricing?.input_audio_cache,
    inputCacheReadPerTokenUsd: model.pricing?.input_cache_read,
    inputCacheWritePerTokenUsd: model.pricing?.input_cache_write,
    inputCacheWrite1hPerTokenUsd: model.pricing?.input_cache_write_1h,
    internalReasoningPerTokenUsd: model.pricing?.internal_reasoning,
    webSearchReportedUsd: model.pricing?.web_search,
  };
  const rates = {
    inputPerTokenUsd: parseReportedRate(reportedRates.inputPerTokenUsd),
    outputPerTokenUsd: parseReportedRate(reportedRates.outputPerTokenUsd),
    imageReportedUsd: parseReportedRate(reportedRates.imageReportedUsd),
    imageOutputReportedUsd: parseReportedRate(reportedRates.imageOutputReportedUsd),
    imageTokenReportedUsd: parseReportedRate(reportedRates.imageTokenReportedUsd),
    requestReportedUsd: parseReportedRate(reportedRates.requestReportedUsd),
    audioInputPerTokenUsd: parseReportedRate(reportedRates.audioInputPerTokenUsd),
    audioOutputPerTokenUsd: parseReportedRate(reportedRates.audioOutputPerTokenUsd),
    inputAudioCachePerTokenUsd: parseReportedRate(reportedRates.inputAudioCachePerTokenUsd),
    inputCacheReadPerTokenUsd: parseReportedRate(reportedRates.inputCacheReadPerTokenUsd),
    inputCacheWritePerTokenUsd: parseReportedRate(reportedRates.inputCacheWritePerTokenUsd),
    inputCacheWrite1hPerTokenUsd: parseReportedRate(reportedRates.inputCacheWrite1hPerTokenUsd),
    internalReasoningPerTokenUsd: parseReportedRate(reportedRates.internalReasoningPerTokenUsd),
    webSearchReportedUsd: parseReportedRate(reportedRates.webSearchReportedUsd),
  };
  const hasAnyRate = Object.values(rates).some((rate) => rate !== null);
  const malformedReportedRates = Object.values(reportedRates).some(
    (value) => value !== undefined && value !== null && parseReportedRate(value) === null
  );
  const completeTokenRates = rates.inputPerTokenUsd !== null && rates.outputPerTokenUsd !== null;
  const isFreeVariant = isOpenRouterFreeModel(model);
  const pricingOverrides = model.pricing?.overrides;
  const hasPricingOverrides = Array.isArray(pricingOverrides) && pricingOverrides.length > 0;
  const malformedPricingOverrides =
    pricingOverrides !== undefined &&
    (!Array.isArray(pricingOverrides) ||
      pricingOverrides.some(
        (override) => !override || typeof override !== "object" || Array.isArray(override)
      ));
  const pricingDiscount = model.pricing?.discount;
  const malformedPricingDiscount =
    pricingDiscount !== undefined &&
    (typeof pricingDiscount !== "number" ||
      !Number.isFinite(pricingDiscount) ||
      pricingDiscount < 0 ||
      pricingDiscount > 1);
  const state: ModelPricingProvenanceState = isFreeVariant
    ? "free_variant"
    : malformedPricingOverrides ||
        malformedReportedRates ||
        malformedPricingDiscount ||
        !hasAnyRate ||
        !completeTokenRates
      ? hasAnyRate ||
        malformedPricingOverrides ||
        malformedReportedRates ||
        malformedPricingDiscount
        ? "incomplete"
        : "unavailable"
      : hasPricingOverrides
        ? "conditional_reported_pricing"
        : "reported";

  return {
    state,
    routeModelId: model.id,
    source: {
      id: "openrouter.models_api",
      modelId: model.id,
      url: "https://openrouter.ai/api/v1/models",
      retrievedAt: options.retrievedAt,
      stale: options.stale,
      cacheTtlMs: options.ttlMs,
    },
    currency: "USD",
    tokenRateUnit: "USD/token",
    rates,
    reportedPricing: model.pricing ?? null,
    ...(pricingOverrides !== undefined ? { overrides: pricingOverrides } : {}),
    ...(model.pricing?.discount !== undefined ? { discountReported: model.pricing.discount } : {}),
    zeroCostEligibility: isFreeVariant
      ? options.stale
        ? "unknown_stale_catalog"
        : "verified_free_variant"
      : "no",
    downstreamHost: { selection: "aggregator_selected", provider: null },
  } as const;
}

/** Legacy /v1/models price shape is USD per million tokens. */
export function toOpenRouterLegacyTokenPricing(
  evidence: ReturnType<typeof buildOpenRouterPricingEvidence>
): Record<string, number> | null {
  if (
    evidence.state === "free_variant" &&
    evidence.zeroCostEligibility === "verified_free_variant"
  ) {
    return { input: 0, output: 0 };
  }
  const { inputPerTokenUsd, outputPerTokenUsd } = evidence.rates;
  if (evidence.state !== "reported" || inputPerTokenUsd === null || outputPerTokenUsd === null) {
    return null;
  }
  const input = Number(inputPerTokenUsd) * 1_000_000;
  const output = Number(outputPerTokenUsd) * 1_000_000;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input, output };
}
