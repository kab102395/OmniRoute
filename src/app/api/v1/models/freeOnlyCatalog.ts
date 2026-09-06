/** Return true only for OpenRouter catalog entries explicitly marked `:free`. */
export function isExplicitOpenRouterFreeCatalogModel(model: Record<string, unknown>): boolean {
  return [model.id, model.root].some(
    (value) =>
      typeof value === "string" &&
      value.startsWith("openrouter/") &&
      value.endsWith(":free")
  );
}
