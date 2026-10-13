/** Return true for an exact current free route or OpenRouter's dynamic free router. */
export function isExplicitOpenRouterFreeCatalogModel(model: Record<string, unknown>): boolean {
  return (
    typeof model.id === "string" &&
    model.id.startsWith("openrouter/") &&
    model.owned_by === "openrouter" &&
    model.free === true
  );
}
