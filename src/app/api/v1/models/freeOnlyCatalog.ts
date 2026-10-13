/** Return true for an exact current free route or OpenRouter's dynamic free router. */
export function isExplicitOpenRouterFreeCatalogModel(model: Record<string, unknown>): boolean {
  return (
    typeof model.id === "string" &&
    model.id.startsWith("openrouter/") &&
    model.owned_by === "openrouter" &&
    model.free === true
  );
}

type UnknownRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep only routes with a bounded zero-cost offering. Curated provider tiers qualify only
 * when OmniRoute's catalog records a provider hard stop, so exhausted quota cannot become paid.
 */
export function isFreeOnlyCatalogModel(model: Record<string, unknown>): boolean {
  if (isExplicitOpenRouterFreeCatalogModel(model)) return true;
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
