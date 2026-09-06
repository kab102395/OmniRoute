import type { OdysseusMetadata, PolicyDecision } from "./policy";

export type UsageSource = "measured" | "estimated" | "unavailable";

export interface OdysseusTelemetry {
  request_id: string | null;
  odysseus_task_id: string | null;
  odysseus_role: string | null;
  odysseus_privacy_class: string | null;
  odysseus_policy_version: string | null;
  provider: string | null;
  provider_account: string | null;
  requested_model: string | null;
  actual_model: string | null;
  routing_pool: string | null;
  routing_reason: string | null;
  free_only: boolean | null;
  free_route_verified: boolean | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  start_time: string | null;
  first_token_latency_ms: number | null;
  completion_latency_ms: number | null;
  wall_clock_ms: number | null;
  output_tokens_per_second: number | null;
  retry_count: number | null;
  fallback_count: number | null;
  fallback_chain: string[] | null;
  quota_before: unknown;
  quota_after: unknown;
  rate_limit_state: string | null;
  provider_error: string | null;
  success: boolean | null;
  policy_result: string;
  usage_source: UsageSource;
}

export function createOdysseusTelemetry(
  decision: PolicyDecision,
  requestId: string | null = null,
  requestedModel: string | null = null
): OdysseusTelemetry {
  const metadata: OdysseusMetadata | null = decision.metadata;
  const route = decision.selectedRoute;
  return {
    request_id: requestId,
    odysseus_task_id: metadata?.taskId ?? null,
    odysseus_role: metadata?.role ?? null,
    odysseus_privacy_class: metadata?.privacyClass ?? null,
    odysseus_policy_version: metadata?.policyVersion ?? null,
    provider: route?.provider ?? null,
    provider_account: null,
    requested_model: requestedModel,
    actual_model: route?.model ?? null,
    routing_pool: metadata ? `odysseus-free-${metadata.role}` : null,
    routing_reason: route ? "approved_exact_route" : decision.reason,
    free_only: metadata?.freeOnly ?? null,
    free_route_verified: route ? route.pricing === "free_api_tier" : false,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    start_time: null,
    first_token_latency_ms: null,
    completion_latency_ms: null,
    wall_clock_ms: null,
    output_tokens_per_second: null,
    retry_count: null,
    fallback_count: null,
    fallback_chain: null,
    quota_before: null,
    quota_after: null,
    rate_limit_state: null,
    provider_error: null,
    success: decision.result === "allowed" ? null : false,
    policy_result: decision.result === "allowed" ? "allowed" : (decision.reason ?? decision.result),
    usage_source: "unavailable",
  };
}
