import { getCodexRequestDefaults } from "../../src/lib/providers/requestDefaults.ts";
import { getProviderConnections } from "../../src/lib/db/providers.ts";
import { AI_PROVIDERS, NOAUTH_PROVIDERS } from "../../src/shared/constants/providers.ts";

type JsonRecord = Record<string, unknown>;
type McpCatalogStatus = "available" | "degraded" | "unavailable" | "unknown";
type McpToolSupportStatus = "supported" | "unsupported" | "unknown";

type McpCatalogModel = {
  id: string;
  provider: string;
  capabilities: string[];
  status: McpCatalogStatus;
  thinkingEffort?: string;
  pricing?: unknown;
  pricingProvenance?: JsonRecord;
  capabilityStatus?: JsonRecord;
  toolCallingStatus: McpToolSupportStatus;
  supportedParameters?: string[];
  inputModalities?: string[];
  outputModalities?: string[];
  contextLength?: number;
  maxOutputTokens?: number;
  free?: boolean;
  freeAccess?: JsonRecord;
  routeSelection?: JsonRecord;
  routeAvailability?: JsonRecord;
  providerRoutes?: JsonRecord[];
  providerRoutesProvenance?: JsonRecord;
};

type McpCatalogResponse = {
  models: McpCatalogModel[];
  source: string;
  warning?: string;
};

type ProviderConnectionLike = {
  id?: string;
  provider?: string;
  isActive?: boolean;
  providerSpecificData?: unknown;
};

type McpCatalogRequestSpec = {
  provider: string;
  path: string;
  thinkingEffort?: string;
};

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : fallback;
}

function buildProviderAliasMap(): Record<string, string> {
  const aliasMap: Record<string, string> = {};

  for (const provider of Object.values(AI_PROVIDERS)) {
    if (!provider?.id) continue;
    aliasMap[provider.id] = provider.id;
    if (typeof provider.alias === "string" && provider.alias.length > 0) {
      aliasMap[provider.alias] = provider.id;
    }
  }

  for (const provider of Object.values(NOAUTH_PROVIDERS)) {
    if (!provider?.id) continue;
    aliasMap[provider.id] = provider.id;
    if ("alias" in provider && typeof provider.alias === "string" && provider.alias.length > 0) {
      aliasMap[provider.alias] = provider.id;
    }
  }

  return aliasMap;
}

function normalizeCapability(value: string): string {
  switch (value) {
    case "embeddings":
      return "embedding";
    case "images":
      return "image";
    case "videos":
      return "video";
    case "moderations":
      return "moderation";
    case "chat-completions":
      return "chat";
    default:
      return value;
  }
}

function getCatalogModelCapabilities(model: JsonRecord): string[] {
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    return toStringArray(model.capabilities, ["chat"]).map(normalizeCapability);
  }

  if (Array.isArray(model.supportedEndpoints) && model.supportedEndpoints.length > 0) {
    return toStringArray(model.supportedEndpoints, ["chat"]).map(normalizeCapability);
  }

  const type = toString(model.type);
  if (type) return [normalizeCapability(type)];

  return ["chat"];
}

function normalizeCatalogStatus(
  model: JsonRecord,
  source: string,
  warning?: string
): McpCatalogStatus {
  const explicitStatus = toString(model.status);
  if (
    explicitStatus === "available" ||
    explicitStatus === "degraded" ||
    explicitStatus === "unavailable"
  ) {
    return explicitStatus;
  }

  if (warning || source === "local_catalog") return "degraded";
  // A successful model-list response proves discovery only. It does not prove
  // the configured account can execute the route, so absence of an explicit
  // provider status must remain unknown rather than being promoted to available.
  return "unknown";
}

function getConnectionThinkingEffort(connection: ProviderConnectionLike): string | undefined {
  const provider = typeof connection.provider === "string" ? connection.provider : null;
  const providerSpecificData = toRecord(connection.providerSpecificData);

  if (provider === "codex") {
    return getCodexRequestDefaults(providerSpecificData).reasoningEffort || "medium";
  }

  const rawThinkingEffort = toString(providerSpecificData.thinkingEffort);
  return rawThinkingEffort || undefined;
}

function normalizeProviderModelRecord(
  rawModel: unknown,
  fallbackProvider: string,
  source: string,
  warning?: string,
  thinkingEffort?: string
) {
  const model = toRecord(rawModel);
  const id = toString(model.id, "");
  const capabilityStatus = toRecord(model.capability_status);
  const toolCalling = toRecord(capabilityStatus.tool_calling);
  const explicitToolStatus = toString(toolCalling.status);
  const legacyToolSupport =
    typeof model.supports_tools === "boolean"
      ? model.supports_tools
      : typeof toRecord(model.capabilities).tool_calling === "boolean"
        ? (toRecord(model.capabilities).tool_calling as boolean)
        : undefined;
  const contextLength =
    typeof model.context_length === "number" &&
    Number.isFinite(model.context_length) &&
    model.context_length > 0
      ? model.context_length
      : typeof model.inputTokenLimit === "number" &&
          Number.isFinite(model.inputTokenLimit) &&
          model.inputTokenLimit > 0
        ? model.inputTokenLimit
        : undefined;
  const maxOutputTokens =
    typeof model.max_output_tokens === "number" &&
    Number.isFinite(model.max_output_tokens) &&
    model.max_output_tokens > 0
      ? model.max_output_tokens
      : typeof model.outputTokenLimit === "number" &&
          Number.isFinite(model.outputTokenLimit) &&
          model.outputTokenLimit > 0
        ? model.outputTokenLimit
        : undefined;
  const toolCallingStatus: McpToolSupportStatus =
    explicitToolStatus === "supported" ||
    explicitToolStatus === "unsupported" ||
    explicitToolStatus === "unknown"
      ? explicitToolStatus
      : legacyToolSupport === true
        ? "supported"
        : legacyToolSupport === false
          ? "unsupported"
          : "unknown";

  return {
    id,
    provider: toString(model.owned_by, toString(model.provider, fallbackProvider)),
    capabilities: getCatalogModelCapabilities(model),
    status: normalizeCatalogStatus(model, source, warning),
    toolCallingStatus,
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(typeof model.free === "boolean" ? { free: model.free } : {}),
    ...(Object.keys(toRecord(model.pricing_provenance)).length > 0
      ? { pricingProvenance: toRecord(model.pricing_provenance) }
      : {}),
    ...(Object.keys(capabilityStatus).length > 0 ? { capabilityStatus } : {}),
    ...(Array.isArray(model.supported_parameters)
      ? { supportedParameters: toStringArray(model.supported_parameters) }
      : {}),
    ...(Array.isArray(model.input_modalities)
      ? { inputModalities: toStringArray(model.input_modalities) }
      : {}),
    ...(Array.isArray(model.output_modalities)
      ? { outputModalities: toStringArray(model.output_modalities) }
      : {}),
    ...(Object.keys(toRecord(model.free_access)).length > 0
      ? { freeAccess: toRecord(model.free_access) }
      : {}),
    ...(Object.keys(toRecord(model.route_selection)).length > 0
      ? { routeSelection: toRecord(model.route_selection) }
      : {}),
    ...(Object.keys(toRecord(model.route_availability)).length > 0
      ? { routeAvailability: toRecord(model.route_availability) }
      : {}),
    ...(Array.isArray(model.provider_routes)
      ? { providerRoutes: model.provider_routes.map(toRecord) }
      : {}),
    ...(Object.keys(toRecord(model.provider_routes_provenance)).length > 0
      ? { providerRoutesProvenance: toRecord(model.provider_routes_provenance) }
      : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
    pricing: model.pricing,
  };
}

function activeProviderConnections(
  connections: ProviderConnectionLike[],
  normalizeProviderId: (value: string) => string,
  requestedProvider: string | null
): ProviderConnectionLike[] {
  return connections.filter((connection) => {
    const provider =
      typeof connection?.provider === "string" ? normalizeProviderId(connection.provider) : null;
    return (
      !!provider &&
      !!connection?.id &&
      connection.isActive !== false &&
      (!requestedProvider || provider === requestedProvider)
    );
  });
}

function providerModelRequestSpecs(
  connections: ProviderConnectionLike[],
  normalizeProviderId: (value: string) => string
): McpCatalogRequestSpec[] {
  return connections.map((connection) => ({
    provider: normalizeProviderId(String(connection.provider)),
    path: `/api/providers/${encodeURIComponent(String(connection.id))}/models?excludeHidden=true`,
    thinkingEffort: getConnectionThinkingEffort(connection),
  }));
}

function noAuthProviderSpec(requestedProvider: string): McpCatalogRequestSpec {
  return {
    provider: requestedProvider,
    path: `/api/v1/providers/${encodeURIComponent(requestedProvider)}/models`,
    thinkingEffort: undefined,
  };
}

function emptyCatalogForProvider(requestedProvider: string): McpCatalogResponse {
  return {
    models: [],
    source: "provider_connections",
    warning: `No active connections found for provider '${requestedProvider}'.`,
  };
}

function rawModelsFromCatalog(raw: JsonRecord): unknown[] {
  if (Array.isArray(raw.models)) return raw.models;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

function maybeCatalogModel(
  rawModel: unknown,
  spec: McpCatalogRequestSpec,
  source: string,
  warning: string | undefined,
  requestedCapability: string | null
): McpCatalogResponse["models"][number] | null {
  const normalized = normalizeProviderModelRecord(rawModel, spec.provider, source, warning);
  if (spec.thinkingEffort && !normalized.thinkingEffort)
    normalized.thinkingEffort = spec.thinkingEffort;
  if (!normalized.id) return null;
  if (requestedCapability && !normalized.capabilities.includes(requestedCapability)) return null;
  return normalized;
}

function addCatalogModels(
  raw: JsonRecord,
  spec: McpCatalogRequestSpec,
  source: string,
  warning: string | undefined,
  requestedCapability: string | null,
  collectedModels: Map<string, McpCatalogResponse["models"][number]>
) {
  for (const rawModel of rawModelsFromCatalog(raw)) {
    const normalized = maybeCatalogModel(rawModel, spec, source, warning, requestedCapability);
    if (normalized) collectedModels.set(`${normalized.provider}:${normalized.id}`, normalized);
  }
}

async function collectCatalogModels(
  requestSpecs: McpCatalogRequestSpec[],
  fetchJson: (path: string) => Promise<unknown>,
  requestedCapability: string | null
) {
  const collectedModels = new Map<string, McpCatalogResponse["models"][number]>();
  const warnings = new Set<string>();
  const sources = new Set<string>();

  for (const spec of requestSpecs) {
    const raw = toRecord(await fetchJson(spec.path));
    const source = toString(
      raw.source,
      spec.path.startsWith("/api/providers/") ? "api" : "v1_catalog"
    );
    const warning = raw.warning ? String(raw.warning) : undefined;
    if (warning) warnings.add(warning);
    sources.add(source);
    addCatalogModels(raw, spec, source, warning, requestedCapability, collectedModels);
  }

  return { collectedModels, warnings, sources };
}

export async function getMcpModelsCatalog(
  args: { provider?: string; capability?: string },
  deps: {
    fetchJson?: (path: string) => Promise<unknown>;
    listProviderConnections?: () => Promise<ProviderConnectionLike[]>;
  } = {}
): Promise<McpCatalogResponse> {
  const fetchJson =
    deps.fetchJson ?? ((path: string) => import("./server.ts").then((m) => m.omniRouteFetch(path)));
  const listProviderConnections = deps.listProviderConnections ?? getProviderConnections;
  const aliasMap = buildProviderAliasMap();
  const normalizeProviderId = (value: string) => aliasMap[value] || value;
  const requestedProvider = args.provider ? normalizeProviderId(args.provider) : null;
  const requestedCapability = args.capability ? normalizeCapability(args.capability) : null;

  let connections = await listProviderConnections();
  connections = Array.isArray(connections) ? connections : [];
  const activeConnections = activeProviderConnections(
    connections,
    normalizeProviderId,
    requestedProvider
  );
  const requestSpecs = providerModelRequestSpecs(activeConnections, normalizeProviderId);

  if (requestedProvider && requestSpecs.length === 0) {
    const isNoAuthProvider = Object.values(NOAUTH_PROVIDERS).some(
      (provider) => provider.id === requestedProvider
    );
    if (isNoAuthProvider) {
      requestSpecs.push(noAuthProviderSpec(requestedProvider));
    } else {
      return emptyCatalogForProvider(requestedProvider);
    }
  }

  const { collectedModels, warnings, sources } = await collectCatalogModels(
    requestSpecs,
    fetchJson,
    requestedCapability
  );

  return {
    models: [...collectedModels.values()],
    source: sources.size === 1 ? [...sources][0] : "aggregated_provider_models",
    ...(warnings.size > 0 ? { warning: [...warnings].join(" | ") } : {}),
  };
}
