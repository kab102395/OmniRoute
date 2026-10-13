import { SAFE_OUTBOUND_FETCH_PRESETS, safeOutboundFetch } from "@/shared/network/safeOutboundFetch";
import { getProviderOutboundGuard } from "@/shared/network/outboundUrlGuardPolicy";
import {
  getAntigravityModelsDiscoveryUrls,
  getAntigravityFetchAvailableModelsUrls,
} from "@omniroute/open-sse/config/antigravityUpstream.ts";
import { getAntigravityContentHeaders } from "@omniroute/open-sse/services/antigravityHeaders.ts";
import { resolveAntigravityClientVersion } from "@omniroute/open-sse/services/antigravityClientProfile.ts";
import {
  getClientVisibleAntigravityModelName,
  isDiscoverableAntigravityModelId,
  toClientAntigravityModelId,
} from "@omniroute/open-sse/config/antigravityModelAliases.ts";
import {
  getClientVisibleAgyModelName,
  isDiscoverableAgyModelId,
} from "@omniroute/open-sse/config/agyModels.ts";
import { normalizeAntigravityClientProfile } from "@/shared/constants/antigravityClientProfile";
import { ensureAntigravityProjectAssigned } from "@omniroute/open-sse/services/antigravityProjectBootstrap.ts";
import { persistDiscoveredAntigravityProjectId } from "@omniroute/open-sse/services/antigravityProjectPersist.ts";
import { asRecord, toNonEmptyString } from "./helpers";

const antigravityDiscoveryInflight = new Map<
  string,
  Promise<Array<{ id: string; name: string }>>
>();

type AntigravityDiscoveryModel = {
  id: string;
  name: string;
  isInternal?: boolean;
  /** Token window advertised by the upstream discovery payload, when present. */
  inputTokenLimit?: number;
  outputTokenLimit?: number;
};

/**
 * Forward discovery-advertised token windows when the upstream payload carries
 * them. Field names are probed defensively (payload shape is not contractual);
 * absent/non-numeric fields yield no entry, so nothing downstream changes.
 */
function extractDiscoveryTokenLimits(item: Record<string, unknown>): {
  inputTokenLimit?: number;
  outputTokenLimit?: number;
} {
  const limits: { inputTokenLimit?: number; outputTokenLimit?: number } = {};
  const input = item.inputTokenLimit ?? item.contextWindow;
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    limits.inputTokenLimit = input;
  }
  const output = item.outputTokenLimit ?? item.maxOutputTokens;
  if (typeof output === "number" && Number.isFinite(output) && output > 0) {
    limits.outputTokenLimit = output;
  }
  return limits;
}

export function normalizeAntigravityModelsResponse(data: unknown): AntigravityDiscoveryModel[] {
  const payload = asRecord(data).models;

  if (Array.isArray(payload)) {
    return payload
      .map((value) => {
        const item = asRecord(value);
        const id =
          typeof item.id === "string"
            ? item.id
            : typeof item.name === "string"
              ? item.name
              : typeof item.model === "string"
                ? item.model
                : "";
        const name =
          typeof item.displayName === "string"
            ? item.displayName
            : typeof item.name === "string"
              ? item.name
              : id;
        return id
          ? {
              id,
              name,
              ...extractDiscoveryTokenLimits(item),
              ...(item.isInternal === true ? { isInternal: true } : {}),
            }
          : null;
      })
      .filter((value): value is AntigravityDiscoveryModel => Boolean(value));
  }

  const modelsById = asRecord(payload);
  return Object.entries(modelsById)
    .map(([id, value]) => {
      const item = asRecord(value);
      const name =
        typeof item.displayName === "string"
          ? item.displayName
          : typeof item.name === "string"
            ? item.name
            : id;
      return id
        ? {
            id,
            name,
            ...extractDiscoveryTokenLimits(item),
            ...(item.isInternal === true ? { isInternal: true } : {}),
          }
        : null;
    })
    .filter((value): value is AntigravityDiscoveryModel => Boolean(value));
}

export function filterUserCallableAntigravityModels(
  models: AntigravityDiscoveryModel[],
  provider: "antigravity" | "agy" = "antigravity"
) {
  return models.filter(
    (model) =>
      model.isInternal !== true &&
      (provider === "agy"
        ? isDiscoverableAgyModelId(model.id)
        : isDiscoverableAntigravityModelId(model.id))
  );
}

export function mapAntigravityModelForClient(
  model: { id: string; name: string; inputTokenLimit?: number; outputTokenLimit?: number },
  provider: "antigravity" | "agy" = "antigravity"
): {
  id: string;
  name: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
} {
  const clientId = toClientAntigravityModelId(model.id);
  return {
    id: clientId,
    name:
      provider === "agy"
        ? getClientVisibleAgyModelName(clientId, model.name)
        : getClientVisibleAntigravityModelName(clientId, model.name),
    ...(typeof model.inputTokenLimit === "number"
      ? { inputTokenLimit: model.inputTokenLimit }
      : {}),
    ...(typeof model.outputTokenLimit === "number"
      ? { outputTokenLimit: model.outputTokenLimit }
      : {}),
  };
}

export async function fetchAntigravityDiscoveryModelsCached(
  accessToken: string,
  connectionId: string,
  proxy: unknown,
  providerSpecificData?: unknown,
  provider: "antigravity" | "agy" = "antigravity"
): Promise<
  Array<{ id: string; name: string; inputTokenLimit?: number; outputTokenLimit?: number }>
> {
  const profile = normalizeAntigravityClientProfile(asRecord(providerSpecificData).clientProfile);
  const cacheKey = `${provider}:${connectionId}:${accessToken.substring(0, 16)}:${profile}`;
  const inflight = antigravityDiscoveryInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = (async () => {
    await resolveAntigravityClientVersion(profile);
    const discovered = await ensureAntigravityProjectAssigned(accessToken, fetch, profile);
    if (discovered) {
      // #8491: persist the recovered id so it survives the next token refresh
      // or process restart instead of being silently rediscovered every time.
      await persistDiscoveredAntigravityProjectId(
        connectionId,
        discovered,
        asRecord(providerSpecificData)
      );
    }

    for (const discoveryUrl of [
      ...getAntigravityFetchAvailableModelsUrls(),
      ...getAntigravityModelsDiscoveryUrls(),
    ]) {
      try {
        const response = await safeOutboundFetch(discoveryUrl, {
          ...SAFE_OUTBOUND_FETCH_PRESETS.modelsDiscovery,
          guard: getProviderOutboundGuard(),
          proxyConfig: proxy,
          method: "POST",
          headers: getAntigravityContentHeaders(profile, accessToken),
          body: JSON.stringify({}),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.warn(
            `[models] ${provider} discovery failed at ${discoveryUrl} (${response.status}): ${errorText}`
          );
          continue;
        }

        const models = filterUserCallableAntigravityModels(
          normalizeAntigravityModelsResponse(await response.json()),
          provider
        ).map((model) => mapAntigravityModelForClient(model, provider));
        if (models.length > 0) {
          return models;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[models] ${provider} discovery threw for ${discoveryUrl}: ${message}`);
      }
    }

    return [];
  })().finally(() => {
    antigravityDiscoveryInflight.delete(cacheKey);
  });

  antigravityDiscoveryInflight.set(cacheKey, promise);
  return promise;
}

export function normalizeDataRobotCatalogResponse(
  data: unknown
): Array<{ id: string; name: string }> {
  const items = Array.isArray(asRecord(data).data) ? (asRecord(data).data as unknown[]) : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const model =
        toNonEmptyString(item.model) || toNonEmptyString(item.id) || toNonEmptyString(item.name);
      if (!model) return null;
      if (item.isActive === false) return null;
      const name = toNonEmptyString(item.label) || toNonEmptyString(item.displayName) || model;
      return { id: model, name };
    })
    .filter((value): value is { id: string; name: string } => Boolean(value));
}

export function normalizeOpenAiLikeModelsResponse(
  data: unknown,
  fallbackOwner: string
): Array<{
  id: string;
  name: string;
  owned_by: string;
  input_modalities?: string[];
  output_modalities?: string[];
  provider_routes?: Array<Record<string, unknown>>;
  provider_routes_retrieved_at?: string;
}> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) || toNonEmptyString(item.model) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      const architecture = asRecord(item.architecture);
      const inputModalities = normalizeStringList(
        item.input_modalities ?? architecture.input_modalities
      );
      const outputModalities = normalizeStringList(
        item.output_modalities ?? architecture.output_modalities
      );
      const providerRoutes =
        fallbackOwner === "huggingface" ? normalizeHuggingFaceProviderRoutes(item.providers) : [];
      return {
        id,
        name,
        owned_by: ownedBy,
        ...(inputModalities.length > 0 ? { input_modalities: inputModalities } : {}),
        ...(outputModalities.length > 0 ? { output_modalities: outputModalities } : {}),
        ...(providerRoutes.length > 0
          ? {
              provider_routes: providerRoutes,
              provider_routes_retrieved_at: new Date().toISOString(),
            }
          : {}),
      };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => toNonEmptyString(entry)?.toLowerCase())
        .filter((entry): entry is string => Boolean(entry))
    )
  );
}

function normalizeHuggingFaceProviderRoutes(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const route = asRecord(candidate);
    const provider = toNonEmptyString(route.provider);
    if (!provider) return [];

    const normalized: Record<string, unknown> = { provider };
    if (route.status === "live" || route.status === "error") normalized.status = route.status;
    if (
      typeof route.context_length === "number" &&
      Number.isFinite(route.context_length) &&
      route.context_length > 0
    ) {
      normalized.context_length = route.context_length;
    }
    if (typeof route.is_free === "boolean") normalized.is_free = route.is_free;
    if (typeof route.supports_tools === "boolean") normalized.supports_tools = route.supports_tools;
    if (typeof route.supports_structured_output === "boolean") {
      normalized.supports_structured_output = route.supports_structured_output;
    }
    if (
      typeof route.first_token_latency_ms === "number" &&
      Number.isFinite(route.first_token_latency_ms) &&
      route.first_token_latency_ms >= 0
    ) {
      normalized.first_token_latency_ms = route.first_token_latency_ms;
    }
    if (
      typeof route.throughput === "number" &&
      Number.isFinite(route.throughput) &&
      route.throughput >= 0
    ) {
      normalized.throughput = route.throughput;
    }
    if (typeof route.is_model_author === "boolean")
      normalized.is_model_author = route.is_model_author;

    const pricing = asRecord(route.pricing);
    const normalizedPricing = Object.fromEntries(
      ["input", "output"].flatMap((dimension) => {
        const price = pricing[dimension];
        return typeof price === "number" && Number.isFinite(price) && price >= 0
          ? [[dimension, price]]
          : [];
      })
    );
    if (Object.keys(normalizedPricing).length > 0) normalized.pricing = normalizedPricing;
    return [normalized];
  });
}

export function normalizeSapModelsResponse(
  data: unknown
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(payload.resources) ? (payload.resources as unknown[]) : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.model) || toNonEmptyString(item.id) || toNonEmptyString(item.name);
      if (!id) return null;
      const name =
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy = toNonEmptyString(item.provider) || "sap";
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}

export function normalizeAzureModelsResponse(
  data: unknown,
  fallbackOwner = "azure-ai"
): Array<{ id: string; name: string; owned_by: string }> {
  const payload = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(payload.data)
      ? (payload.data as unknown[])
      : Array.isArray(payload.models)
        ? (payload.models as unknown[])
        : Array.isArray(payload.value)
          ? (payload.value as unknown[])
          : Array.isArray(payload.deployments)
            ? (payload.deployments as unknown[])
            : [];

  return items
    .map((value) => {
      const item = asRecord(value);
      const id =
        toNonEmptyString(item.id) ||
        toNonEmptyString(item.deployment_name) ||
        toNonEmptyString(item.deploymentName) ||
        toNonEmptyString(item.name) ||
        toNonEmptyString(item.model);
      if (!id) return null;
      const name =
        toNonEmptyString(item.display_name) ||
        toNonEmptyString(item.displayName) ||
        toNonEmptyString(item.name) ||
        id;
      const ownedBy =
        toNonEmptyString(item.owned_by) || toNonEmptyString(item.provider) || fallbackOwner;
      return { id, name, owned_by: ownedBy };
    })
    .filter((value): value is { id: string; name: string; owned_by: string } => Boolean(value));
}
