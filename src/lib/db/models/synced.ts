import { isRetiredGitHubCopilotModelId } from "@omniroute/open-sse/config/providers/registry/github/retiredModels.ts";

import { asRecord, toNonEmptyString } from "./shared";

export interface SyncedAvailableModel {
  id: string;
  name: string;
  source: "imported";
  apiFormat?: string;
  targetFormat?: string;
  upstreamProtocol?: string;
  supportedEndpoints?: string[];
  supportedThinkingEfforts?: string[];
  defaultThinkingEffort?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  description?: string;
  supportsThinking?: boolean;
  alwaysThinking?: boolean;
  supportsTools?: boolean;
  /** Explicit free/paid classification reported by this connection's model catalog. */
  isFree?: boolean;
  /** Time the upstream model catalog supporting these facts was retrieved. */
  catalogRetrievedAt?: string;
  supportsVideo?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  // #4264: image-input capability captured at sync time (e.g. OpenRouter
  // `architecture.input_modalities`/`modality`) so the catalog can surface vision.
  supportsVision?: boolean;
  /** Per-host facts from an upstream router catalog; these do not prove that
   * OmniRoute can pin that host for execution. */
  providerRoutes?: SyncedProviderRoute[];
  providerRoutesRetrievedAt?: string;
}

export interface SyncedProviderRoute {
  provider: string;
  status?: "live" | "error";
  contextLength?: number;
  pricing?: { input?: number; output?: number };
  isFree?: boolean;
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
  firstTokenLatencyMs?: number;
  throughput?: number;
  isModelAuthor?: boolean;
}

export type SyncedAvailableModelInput = Omit<SyncedAvailableModel, "source"> & {
  source?: string;
};

function normalizeSyncedAvailableModel(model: unknown): SyncedAvailableModel | null {
  const record = asRecord(model);
  const id =
    toNonEmptyString(record.id) || toNonEmptyString(record.name) || toNonEmptyString(record.model);
  if (!id) return null;

  const name =
    toNonEmptyString(record.name) ||
    toNonEmptyString(record.displayName) ||
    toNonEmptyString(record.model) ||
    id;
  const supportedEndpoints = Array.isArray(record.supportedEndpoints)
    ? Array.from(
        new Set(
          record.supportedEndpoints
            .map((endpoint) => toNonEmptyString(endpoint))
            .filter((endpoint): endpoint is string => Boolean(endpoint))
        )
      ).sort()
    : undefined;
  const normalizeModalities = (value: unknown) =>
    Array.isArray(value)
      ? Array.from(
          new Set(
            value
              .map((modality) => toNonEmptyString(modality)?.toLowerCase())
              .filter((modality): modality is string => Boolean(modality))
          )
        )
      : undefined;
  const inputModalities = normalizeModalities(record.inputModalities ?? record.input_modalities);
  const outputModalities = normalizeModalities(record.outputModalities ?? record.output_modalities);
  const rawProviderRoutes = record.providerRoutes ?? record.provider_routes;
  const providerRoutes = Array.isArray(rawProviderRoutes)
    ? rawProviderRoutes.flatMap((value): SyncedProviderRoute[] => {
        const route = asRecord(value);
        const provider = toNonEmptyString(route.provider);
        if (!provider) return [];
        const pricingRecord = asRecord(route.pricing);
        const input = finiteNonNegative(pricingRecord.input);
        const output = finiteNonNegative(pricingRecord.output);
        const contextLength = finitePositive(route.contextLength ?? route.context_length);
        const firstTokenLatencyMs = finiteNonNegative(
          route.firstTokenLatencyMs ?? route.first_token_latency_ms
        );
        const throughput = finiteNonNegative(route.throughput);
        const isFree = typeof route.isFree === "boolean" ? route.isFree : route.is_free;
        const supportsTools =
          typeof route.supportsTools === "boolean" ? route.supportsTools : route.supports_tools;
        const supportsStructuredOutput =
          typeof route.supportsStructuredOutput === "boolean"
            ? route.supportsStructuredOutput
            : route.supports_structured_output;
        const isModelAuthor =
          typeof route.isModelAuthor === "boolean" ? route.isModelAuthor : route.is_model_author;
        return [
          {
            provider,
            ...(route.status === "live" || route.status === "error"
              ? { status: route.status }
              : {}),
            ...(contextLength !== undefined ? { contextLength } : {}),
            ...(input !== undefined || output !== undefined
              ? {
                  pricing: {
                    ...(input !== undefined ? { input } : {}),
                    ...(output !== undefined ? { output } : {}),
                  },
                }
              : {}),
            ...(typeof isFree === "boolean" ? { isFree } : {}),
            ...(typeof supportsTools === "boolean" ? { supportsTools } : {}),
            ...(typeof supportsStructuredOutput === "boolean" ? { supportsStructuredOutput } : {}),
            ...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
            ...(throughput !== undefined ? { throughput } : {}),
            ...(typeof isModelAuthor === "boolean" ? { isModelAuthor } : {}),
          },
        ];
      })
    : undefined;

  return {
    id,
    name,
    source: "imported",
    ...(toNonEmptyString(record.apiFormat)
      ? { apiFormat: toNonEmptyString(record.apiFormat)! }
      : {}),
    ...(toNonEmptyString(record.targetFormat)
      ? { targetFormat: toNonEmptyString(record.targetFormat)! }
      : {}),
    ...(toNonEmptyString(record.upstreamProtocol)
      ? { upstreamProtocol: toNonEmptyString(record.upstreamProtocol)! }
      : {}),
    ...(supportedEndpoints && supportedEndpoints.length > 0 ? { supportedEndpoints } : {}),
    ...(inputModalities && inputModalities.length > 0 ? { inputModalities } : {}),
    ...(outputModalities && outputModalities.length > 0 ? { outputModalities } : {}),
    ...(Array.isArray(record.supportedThinkingEfforts)
      ? {
          supportedThinkingEfforts: record.supportedThinkingEfforts.filter(
            (effort): effort is string => typeof effort === "string" && effort.length > 0
          ),
        }
      : {}),
    ...(toNonEmptyString(record.defaultThinkingEffort)
      ? { defaultThinkingEffort: toNonEmptyString(record.defaultThinkingEffort)! }
      : {}),
    ...(typeof record.inputTokenLimit === "number"
      ? { inputTokenLimit: record.inputTokenLimit }
      : {}),
    ...(typeof record.outputTokenLimit === "number"
      ? { outputTokenLimit: record.outputTokenLimit }
      : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.supportsThinking === "boolean"
      ? { supportsThinking: record.supportsThinking }
      : {}),
    ...(record.alwaysThinking === true ? { alwaysThinking: true } : {}),
    ...(typeof record.supportsTools === "boolean" ? { supportsTools: record.supportsTools } : {}),
    ...(typeof record.isFree === "boolean"
      ? { isFree: record.isFree }
      : typeof record.is_free === "boolean"
        ? { isFree: record.is_free }
        : {}),
    ...(toNonEmptyString(record.catalogRetrievedAt ?? record.catalog_retrieved_at)
      ? {
          catalogRetrievedAt: toNonEmptyString(
            record.catalogRetrievedAt ?? record.catalog_retrieved_at
          )!,
        }
      : {}),
    ...(typeof record.supportsVideo === "boolean" ? { supportsVideo: record.supportsVideo } : {}),
    ...(record.supportsVision === true ? { supportsVision: true } : {}),
    ...(providerRoutes && providerRoutes.length > 0 ? { providerRoutes } : {}),
    ...(toNonEmptyString(record.providerRoutesRetrievedAt ?? record.provider_routes_retrieved_at)
      ? {
          providerRoutesRetrievedAt: toNonEmptyString(
            record.providerRoutesRetrievedAt ?? record.provider_routes_retrieved_at
          )!,
        }
      : {}),
  };
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeSyncedAvailableModels(
  models: unknown,
  providerId?: string
): SyncedAvailableModel[] {
  if (!Array.isArray(models)) return [];
  const deduped = new Map<string, SyncedAvailableModel>();
  for (const model of models) {
    const normalized = normalizeSyncedAvailableModel(model);
    if (normalized && !isRetiredGitHubCopilotModelId(providerId, normalized.id)) {
      deduped.set(normalized.id, normalized);
    }
  }
  return Array.from(deduped.values());
}
