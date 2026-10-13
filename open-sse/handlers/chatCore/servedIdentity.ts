/** Route identity paired with the provider response when it reports an effective model. */
import { getProviderNodeByIdSync } from "@/lib/db/providers/nodes";

export type ServedIdentity = {
  /** Public provider prefix. Internal provider-node IDs are never used here when mapped. */
  provider: string;
  model: string;
  modelSource: "provider_response" | "outbound_request";
  providerInstanceId: string | null;
};

type ProviderNodeLookup = (id: string) => { id?: unknown; prefix?: unknown } | null;

export function resolveServedIdentity(
  provider: unknown,
  providerRequest: unknown,
  lookupProviderNode: ProviderNodeLookup = getProviderNodeByIdSync,
  providerResponse?: unknown
): ServedIdentity | null {
  if (typeof provider !== "string" || !provider.trim()) return null;
  if (!providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest)) {
    return null;
  }
  const outboundModel = (providerRequest as Record<string, unknown>).model;
  const reportedModel =
    providerResponse && typeof providerResponse === "object" && !Array.isArray(providerResponse)
      ? (providerResponse as Record<string, unknown>).model
      : null;
  const modelSource =
    typeof reportedModel === "string" && reportedModel.trim()
      ? "provider_response"
      : "outbound_request";
  const model = modelSource === "provider_response" ? reportedModel : outboundModel;
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
    modelSource,
    providerInstanceId: providerNode ? providerInstanceId : null,
  };
}
