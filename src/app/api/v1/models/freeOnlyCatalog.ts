/** Return true only for OpenRouter rows carrying verified zero-price evidence. */
export function isExplicitOpenRouterFreeCatalogModel(model: Record<string, unknown>): boolean {
  return (
    typeof model.id === "string" &&
    model.id.startsWith("openrouter/") &&
    model.owned_by === "openrouter" &&
    model.free === true
  );
}
