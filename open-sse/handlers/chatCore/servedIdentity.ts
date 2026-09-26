/** Resolved identity captured from the final provider request accepted by chatCore. */
export type ServedIdentity = {
  provider: string;
  model: string;
};

export function resolveServedIdentity(
  provider: unknown,
  providerRequest: unknown
): ServedIdentity | null {
  if (typeof provider !== "string" || !provider.trim()) return null;
  if (!providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest)) {
    return null;
  }
  const model = (providerRequest as Record<string, unknown>).model;
  if (typeof model !== "string" || !model.trim()) return null;
  return { provider: provider.trim(), model: model.trim() };
}
