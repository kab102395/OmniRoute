import { getProviderConnections } from "@/lib/db/providers";

export const DETERMINISTIC_CODESRAL_ALIASES = Object.freeze({
  accountA: "mistral/codestral-account-a",
  accountB: "mistral/codestral-account-b",
});

export type DeterministicProviderRoute = {
  routeId: string;
  requestedAlias: string;
  provider: "mistral";
  servedModel: "mistral/codestral-latest";
  credentialAlias: "codestral-account-a" | "codestral-account-b";
  connectionId: string | null;
  keySlot: "primary" | "extra_0";
  available: boolean;
};

/** Non-secret response identity for pinned deterministic routes. */
export function deterministicProviderRouteHeaders(
  route: DeterministicProviderRoute | null | undefined
): Record<string, string> {
  if (!route) return {};
  return {
    "X-OmniRoute-Route-Id": route.routeId,
    "X-OmniRoute-Requested-Model": route.requestedAlias,
    "X-OmniRoute-Served-Model": route.servedModel,
    "X-OmniRoute-Provider": route.provider,
    "X-OmniRoute-Credential-Alias": route.credentialAlias,
    "X-OmniRoute-Key-Slot": route.keySlot,
    ...(route.connectionId ? { "X-OmniRoute-Connection-Id": route.connectionId } : {}),
  };
}

type RouteCandidate = {
  connectionId: string;
  keySlot: "primary" | "extra_0";
};

type MistralConnectionCandidate = {
  id?: unknown;
  apiKey?: unknown;
  providerSpecificData?: unknown;
};

const ROUTE_DEFINITIONS = Object.freeze([
  {
    alias: DETERMINISTIC_CODESRAL_ALIASES.accountA,
    routeId: "mistral-codestral-account-a",
    credentialAlias: "codestral-account-a",
    candidateIndex: 0,
  },
  {
    alias: DETERMINISTIC_CODESRAL_ALIASES.accountB,
    routeId: "mistral-codestral-account-b",
    credentialAlias: "codestral-account-b",
    candidateIndex: 1,
  },
] as const);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function routeDefinition(alias: unknown) {
  return ROUTE_DEFINITIONS.find((route) => route.alias === alias) ?? null;
}

function connectionCandidates(
  connections: readonly MistralConnectionCandidate[]
): RouteCandidate[] {
  const candidates: RouteCandidate[] = [];
  const sorted = [...connections].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const connection of sorted) {
    if (!isNonEmptyString(connection.id)) continue;
    if (isNonEmptyString(connection.apiKey)) {
      candidates.push({ connectionId: connection.id, keySlot: "primary" });
    }

    const providerSpecificData =
      connection.providerSpecificData && typeof connection.providerSpecificData === "object"
        ? (connection.providerSpecificData as Record<string, unknown>)
        : {};
    const extraApiKeys = Array.isArray(providerSpecificData.extraApiKeys)
      ? providerSpecificData.extraApiKeys
      : [];
    if (isNonEmptyString(extraApiKeys[0])) {
      candidates.push({ connectionId: connection.id, keySlot: "extra_0" });
    }
  }

  return candidates;
}

/** Pure route mapping used by tests and by the database-backed resolver. */
export function resolveDeterministicCodestralRouteFromConnections(
  alias: unknown,
  connections: readonly MistralConnectionCandidate[]
): DeterministicProviderRoute | null {
  const definition = routeDefinition(alias);
  if (!definition) return null;

  const candidates = connectionCandidates(connections);
  const selected = candidates[definition.candidateIndex] ?? null;

  return {
    routeId: definition.routeId,
    requestedAlias: definition.alias,
    provider: "mistral",
    servedModel: "mistral/codestral-latest",
    credentialAlias: definition.credentialAlias,
    connectionId: selected?.connectionId ?? null,
    keySlot: selected?.keySlot ?? (definition.candidateIndex === 0 ? "primary" : "extra_0"),
    available: selected !== null,
  };
}

export async function resolveDeterministicProviderRoute(
  alias: unknown
): Promise<DeterministicProviderRoute | null> {
  const definition = routeDefinition(alias);
  if (!definition) return null;

  try {
    const connections = await getProviderConnections({ provider: "mistral", isActive: true });
    return resolveDeterministicCodestralRouteFromConnections(alias, connections);
  } catch {
    return resolveDeterministicCodestralRouteFromConnections(alias, []);
  }
}

export const DETERMINISTIC_PROVIDER_ROUTE_SYMBOL = Symbol.for(
  "omniroute.deterministic-provider-route"
);

export function getDeterministicProviderRoute(body: unknown): DeterministicProviderRoute | null {
  if (!body || typeof body !== "object") return null;
  return (
    ((body as Record<PropertyKey, unknown>)[DETERMINISTIC_PROVIDER_ROUTE_SYMBOL] as
      DeterministicProviderRoute | undefined) ?? null
  );
}

export function applyDeterministicProviderRoute(
  body: Record<string, unknown>,
  route: DeterministicProviderRoute
): void {
  Object.defineProperty(body, DETERMINISTIC_PROVIDER_ROUTE_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: route,
    writable: false,
  });
}

export function applyDeterministicProviderAlias(
  body: Record<string, unknown>,
  route: DeterministicProviderRoute
): void {
  body.model = route.servedModel;
  applyDeterministicProviderRoute(body, route);
}
