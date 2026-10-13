/**
 * Stable `/v1/models` pricing provenance state contract.
 * Keep the OpenAPI Model.pricing_provenance.state enum in sync; the unit
 * contract test compares it directly with this list.
 */
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

export interface ModelPricingProvenance extends Record<string, unknown> {
  state: ModelPricingProvenanceState;
}
