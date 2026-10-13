import { isOpenRouterFreeRouteModel, type OpenRouterCatalogEntry } from "./openrouterCatalog";

export interface DiscoveredFreeModel {
  provider: "openrouter";
  modelId: string;
  routeId: string;
  providerModelId: string;
  displayName: string;
  monthlyTokens: null;
  creditTokens: null;
  freeType: "provider-free-variant";
  poolKey: "openrouter-free";
  tos: "caution";
  source: "openrouter";
  sourceUrl: string;
  lastSeenAt: string;
  catalogRetrievedAt: string | null;
  catalogAvailability: "listed" | "stale";
  accountEligibility: "unknown";
  freeEligibility: "verified_free_variant" | "unknown_stale_catalog";
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  modalities: string[];
  supportedParameters: string[];
  supportsTools: boolean | null;
  supportsReasoning: boolean | null;
  supportsStructuredOutput: boolean | null;
}

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isFree(entry: OpenRouterCatalogEntry): boolean {
  if (entry.id === "openrouter/free") return false;
  return isOpenRouterFreeRouteModel(entry);
}

/**
 * Convert the public OpenRouter catalog into discovery-only free entries.
 * OpenRouter's exact `:free` variant or explicit all-dimension zero rates in
 * the current catalog are authoritative free-route evidence. Quotas and
 * account eligibility remain unknown.
 */
export function discoverOpenRouterFreeModels(
  entries: readonly OpenRouterCatalogEntry[],
  lastSeenAt: string,
  stale = false
): DiscoveredFreeModel[] {
  const seen = new Set<string>();
  const result: DiscoveredFreeModel[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !isFree(entry)) continue;
    const modelId = entry.id.trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);

    result.push({
      provider: "openrouter",
      modelId,
      routeId: `openrouter/${modelId}`,
      providerModelId: modelId,
      displayName: entry.name?.trim() || modelId,
      monthlyTokens: null,
      creditTokens: null,
      freeType: "provider-free-variant",
      poolKey: "openrouter-free",
      tos: "caution",
      source: "openrouter",
      sourceUrl: `https://openrouter.ai/${modelId.split("/").map(encodeURIComponent).join("/")}`,
      lastSeenAt,
      catalogRetrievedAt: lastSeenAt || null,
      catalogAvailability: stale ? "stale" : "listed",
      accountEligibility: "unknown",
      freeEligibility: stale ? "unknown_stale_catalog" : "verified_free_variant",
      contextWindow: positiveFiniteNumber(entry.context_length),
      maxOutputTokens: positiveFiniteNumber(entry.top_provider?.max_completion_tokens),
      inputModalities: normalizeStringList(entry.architecture?.input_modalities),
      outputModalities: normalizeStringList(entry.architecture?.output_modalities),
      modalities: normalizeStringList(
        entry.architecture?.output_modalities ?? entry.architecture?.input_modalities
      ),
      supportedParameters: normalizeStringList(entry.supported_parameters),
      supportsTools: entry.supported_parameters?.includes("tools") ?? null,
      supportsReasoning: entry.supported_parameters?.includes("reasoning") ?? null,
      supportsStructuredOutput:
        entry.supported_parameters === undefined
          ? null
          : entry.supported_parameters.includes("structured_outputs") ||
            entry.supported_parameters.includes("response_format"),
    });
  }

  return result.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
