/** Resolved identity captured from the final provider request accepted by chatCore. */
import { getProviderNodeByIdSync } from "@/lib/db/providers/nodes";

export type ServedIdentity = {
  /** Public provider prefix. Internal provider-node IDs are never used here when mapped. */
  provider: string;
  model: string;
  providerInstanceId: string | null;
};

type ProviderNodeLookup = (id: string) => { id?: unknown; prefix?: unknown } | null;

export function resolveServedIdentity(
  provider: unknown,
  providerRequest: unknown,
  lookupProviderNode: ProviderNodeLookup = getProviderNodeByIdSync
): ServedIdentity | null {
  if (typeof provider !== "string" || !provider.trim()) return null;
  if (!providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest)) {
    return null;
  }
  const model = (providerRequest as Record<string, unknown>).model;
  if (typeof model !== "string" || !model.trim()) return null;

  const providerInstanceId = provider.trim();
  let providerNode: ReturnType<ProviderNodeLookup> = null;
  try {
    providerNode = lookupProviderNode(providerInstanceId);
  } catch {
    // Keep the raw provider as the fail-closed identity if local node metadata is unavailable.
  }
  const publicProvider =
    providerNode && typeof providerNode.prefix === "string" && providerNode.prefix.trim()
      ? providerNode.prefix.trim()
      : providerInstanceId;

  return {
    provider: publicProvider,
    model: model.trim(),
    providerInstanceId: providerNode ? providerInstanceId : null,
  };
}
