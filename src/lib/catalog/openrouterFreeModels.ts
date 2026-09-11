import type { OpenRouterCatalogEntry } from "./openrouterCatalog";

export interface DiscoveredFreeModel {
  provider: "openrouter";
  modelId: string;
  displayName: string;
  monthlyTokens: 0;
  creditTokens: 0;
  freeType: "recurring-uncapped";
  poolKey: "openrouter-free";
  tos: "caution";
  source: "openrouter";
  sourceUrl: string;
  lastSeenAt: string;
  contextWindow: number | null;
  modalities: string[];
  supportsTools: boolean | null;
  supportsReasoning: boolean | null;
}

function isZero(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Number(value)) && Number(value) === 0;
}

function isFree(entry: OpenRouterCatalogEntry): boolean {
  return (
    entry.id.endsWith(":free") ||
    (isZero(entry.pricing?.prompt) && isZero(entry.pricing?.completion))
  );
}

/**
 * Convert the public OpenRouter catalog into discovery-only free entries.
 * These entries are intentionally marked recurring-uncapped and caution:
 * OpenRouter publishes price, but not a guaranteed quota or proxy permission.
 */
export function discoverOpenRouterFreeModels(
  entries: readonly OpenRouterCatalogEntry[],
  lastSeenAt: string
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
      displayName: entry.name?.trim() || modelId,
      monthlyTokens: 0,
      creditTokens: 0,
      freeType: "recurring-uncapped",
      poolKey: "openrouter-free",
      tos: "caution",
      source: "openrouter",
      sourceUrl: `https://openrouter.ai/${modelId.split("/").map(encodeURIComponent).join("/")}`,
      lastSeenAt,
      contextWindow: entry.context_length ?? null,
      modalities:
        entry.architecture?.output_modalities ?? entry.architecture?.input_modalities ?? [],
      supportsTools: entry.supported_parameters?.includes("tools") ?? null,
      supportsReasoning: entry.supported_parameters?.includes("reasoning") ?? null,
    });
  }

  return result.sort((a, b) => a.modelId.localeCompare(b.modelId));
}
