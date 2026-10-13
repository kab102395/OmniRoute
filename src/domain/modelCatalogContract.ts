/** Stable source-backed `/v1/models` model and routing metadata contract. */
export const MODEL_PRICING_PROVENANCE_STATES = [
  "free_variant",
  "reported",
  "conditional_reported_pricing",
  "third_party_reported_pricing",
  "estimated_pricing",
  "unverified_pricing",
  "incomplete",
  "unavailable",
  "unknown_stale_catalog",
  "not_in_current_free_catalog",
] as const;

export type ModelPricingProvenanceState = (typeof MODEL_PRICING_PROVENANCE_STATES)[number];

export interface CatalogMetadataSource extends Record<string, unknown> {
  id: string;
  modelId?: string;
  url?: string;
  retrievedAt?: string | null;
  retrieved_at?: string | null;
  stale?: boolean | null;
  cacheTtlMs?: number | null;
  ageMs?: number | null;
  freshness?: string;
}

export interface ModelPricingRates extends Record<string, unknown> {
  inputPerTokenUsd?: string | null;
  outputPerTokenUsd?: string | null;
  imageReportedUsd?: string | null;
  imageOutputReportedUsd?: string | null;
  imageTokenReportedUsd?: string | null;
  requestReportedUsd?: string | null;
  videoReportedUsd?: string | null;
  audioInputPerTokenUsd?: string | null;
  audioOutputPerTokenUsd?: string | null;
  inputAudioCachePerTokenUsd?: string | null;
  inputCacheReadPerTokenUsd?: string | null;
  inputCacheWritePerTokenUsd?: string | null;
  inputCacheWrite1hPerTokenUsd?: string | null;
  internalReasoningPerTokenUsd?: string | null;
  webSearchReportedUsd?: string | null;
  inputCacheMiss?: { offPeak: number; peak: number };
  inputCacheHit?: { offPeak: number; peak: number };
  output?: { offPeak: number; peak: number };
}

export interface ModelPricingProvenance extends Record<string, unknown> {
  state: ModelPricingProvenanceState;
  routeModelId?: string;
  resolvedModelId?: string;
  servedModelVersion?: string;
  currency?: string;
  tokenRateUnit?: string;
  rateUnit?: string;
  source?: CatalogMetadataSource;
  zeroCostEligibility?: "verified_free_variant" | "unknown_stale_catalog" | "no";
  rates?: ModelPricingRates;
  reportedPricing?: Record<string, unknown> | null;
  reason?: string;
  pricingCondition?: string;
  routeResolution?: {
    modelVersion?: string;
    source?: CatalogMetadataSource;
  };
  downstreamHost?: {
    selection: "aggregator_selected" | "pinned";
    provider?: string | null;
  };
}

export interface CatalogCapabilityStatus {
  tool_calling?: {
    status: "supported" | "unsupported" | "unknown";
    source:
      | "openrouter.models_api"
      | "huggingface.router_models_api"
      | "synced_capability_catalog"
      | "provider_registry"
      | "model_spec"
      | "provider_parameter_constraint"
      | "unknown";
  };
  [key: string]: unknown;
}

export interface CatalogCapabilities extends Record<string, unknown> {
  vision?: boolean;
  tool_calling?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  thinking?: boolean;
  supportsThinking?: boolean;
  attachment?: boolean;
  effort_tiers?: string[];
}

export interface CatalogFreeAccess {
  classification: "documented_free_tier";
  freeType:
    | "recurring-daily"
    | "recurring-monthly"
    | "recurring-credit"
    | "recurring-uncapped"
    | "one-time-initial"
    | "keyless";
  monthlyTokens: number;
  creditTokens: number;
  hardStopGuaranteed: boolean | null;
  accountEligibility: "unknown";
  zeroCostOnExhaustion: "provider_hard_stop" | "not_guaranteed";
  termsOfService: "ok" | "caution" | "ambiguous" | "avoid" | "unknown";
  source: {
    id: "omniroute.free_model_catalog";
    freshness: "release_catalog";
    retrievedAt: null;
  };
}

export interface CatalogRouteSelection {
  kind: "exact_model" | "dynamic_free_model";
  exactModelIdentity: boolean;
}

export interface CatalogRouteAvailability {
  catalogListed: boolean | null;
  accountEligibility: "unknown";
  source?: CatalogMetadataSource;
  downstreamHostSelection?: "aggregator_selected" | "pinned";
}

export interface CatalogProviderRoute {
  provider: string;
  route_model?: string;
  status?: "live" | "error";
  context_length?: number;
  pricing?: Record<string, number>;
  is_free?: boolean;
  free_catalog_eligible?: boolean;
  supports_tools?: boolean;
  supports_structured_output?: boolean;
  first_token_latency_ms?: number;
  throughput?: number;
  is_model_author?: boolean;
  [key: string]: unknown;
}

export interface ModelCatalogEntry extends Record<string, unknown> {
  id: string;
  object?: string;
  owned_by?: string;
  root?: string;
  name?: string;
  created?: number;
  type?: string;
  free?: boolean;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  pricing?: Record<string, unknown>;
  pricing_provenance?: ModelPricingProvenance;
  capabilities?: CatalogCapabilities;
  capability_status?: CatalogCapabilityStatus;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_parameters?: string[];
  free_access?: CatalogFreeAccess;
  route_selection?: CatalogRouteSelection;
  route_availability?: CatalogRouteAvailability;
  provider_routes?: CatalogProviderRoute[];
  provider_routes_provenance?: CatalogMetadataSource & {
    pricing_unit?: string;
  };
}

export interface ModelCatalogResponse extends Record<string, unknown> {
  object: "list";
  data: ModelCatalogEntry[];
  /** Codex-only legacy envelope compatibility; always empty when present. */
  models?: [];
}
