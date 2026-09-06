/**
 * Opt-in Odysseus policy boundary.
 *
 * This module is deliberately independent from provider routing. It answers one
 * question before routing starts: may this request use an exact approved route?
 */

export const ODYSSEUS_ROLES = ["coder", "scout", "reasoner", "compressor"] as const;
export type OdysseusRole = (typeof ODYSSEUS_ROLES)[number];
export const ODYSSEUS_PRIVACY_CLASSES = ["public", "private_source", "sensitive"] as const;
export type OdysseusPrivacyClass = (typeof ODYSSEUS_PRIVACY_CLASSES)[number];
export const ODYSSEUS_ROLE_POOLS: Readonly<Record<OdysseusRole, string>> = {
  coder: "odysseus-free-coder",
  scout: "odysseus-free-scout",
  reasoner: "odysseus-free-reasoner",
  compressor: "odysseus-free-compressor",
};
export type OdysseusPricing = "free_api_tier" | "signup_credit_only" | "paid" | "unknown";
export type PolicyResult = "disabled" | "allowed" | "denied";
export type PolicyReason =
  | "NO_APPROVED_FREE_ROUTE"
  | "FREE_QUOTA_EXHAUSTED"
  | "PROVIDER_UNAVAILABLE"
  | "POLICY_DENIED"
  | "PRIVACY_DENIED"
  | "MALFORMED_POLICY"
  | "UNKNOWN_ROLE"
  | "UNKNOWN_PRIVACY_CLASS"
  | "UNSUPPORTED_ROUTE";

export interface OdysseusMetadata {
  taskId: string;
  role: OdysseusRole;
  privacyClass: OdysseusPrivacyClass;
  freeOnly: boolean;
  allowedRoutes: string[];
  policyVersion: string;
}

export interface OdysseusRouteApproval {
  provider: string;
  model: string;
  role: OdysseusRole;
  enabled: boolean;
  approvalStatus: "approved" | "rejected" | "pending";
  pricing: OdysseusPricing;
  signupCreditAllowed?: boolean;
  privateSourceApproved?: boolean;
  benchmarkVersion?: string;
  benchmarkScore?: number;
  notes?: string;
  revalidateAt?: string;
  quotaAvailable?: boolean;
  providerAvailable?: boolean;
  dataRetention: "known" | "unknown" | "not_retained";
  trainingOnInput: "allowed" | "unknown" | "forbidden";
  riskCategory: "low" | "medium" | "high" | "unknown";
}

export interface PolicyDecision {
  result: PolicyResult;
  reason: PolicyReason | null;
  metadata: OdysseusMetadata | null;
  selectedRoute: OdysseusRouteApproval | null;
  candidates: OdysseusRouteApproval[];
}

export const ODYSSEUS_HEADER_NAMES = {
  taskId: "x-odysseus-task-id",
  role: "x-odysseus-role",
  privacyClass: "x-odysseus-privacy-class",
  freeOnly: "x-odysseus-free-only",
  allowedRoutes: "x-odysseus-allowed-routes",
  policyVersion: "x-odysseus-policy-version",
} as const;

/** One operator-attested route. It is intentionally the only built-in route. */
export const DEFAULT_ODYSSEUS_APPROVALS: readonly OdysseusRouteApproval[] = [
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    role: "scout",
    enabled: true,
    approvalStatus: "approved",
    pricing: "free_api_tier",
    signupCreditAllowed: false,
    privateSourceApproved: false,
    dataRetention: "unknown",
    trainingOnInput: "unknown",
    riskCategory: "unknown",
    notes: "Operator-attested free route; verify current provider terms before production use.",
  },
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseCsv(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())) {
    return value.map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return null;
}

function isRole(value: unknown): value is OdysseusRole {
  return typeof value === "string" && (ODYSSEUS_ROLES as readonly string[]).includes(value);
}

function isPrivacyClass(value: unknown): value is OdysseusPrivacyClass {
  return (
    typeof value === "string" && (ODYSSEUS_PRIVACY_CLASSES as readonly string[]).includes(value)
  );
}

/** Parse either the documented headers or the body `odysseus_policy` extension. */
export function parseOdysseusMetadata(
  headers: Headers,
  body: unknown = null
):
  | { enabled: false }
  | { enabled: true; metadata: OdysseusMetadata }
  | { enabled: true; reason: PolicyReason } {
  const bodyRecord = record(body);
  const bodyPolicy = record(bodyRecord?.odysseus_policy);
  const read = (key: keyof typeof ODYSSEUS_HEADER_NAMES, bodyKey: string): unknown =>
    headers.get(ODYSSEUS_HEADER_NAMES[key]) ?? bodyPolicy?.[bodyKey];

  const activated =
    bodyPolicy !== null || Object.values(ODYSSEUS_HEADER_NAMES).some((name) => headers.has(name));
  if (!activated) return { enabled: false };

  const taskId = text(read("taskId", "task_id"));
  const role = read("role", "role");
  const privacyClass = read("privacyClass", "privacy_class");
  const freeOnly = parseBoolean(read("freeOnly", "free_only"));
  const allowedRoutes = parseCsv(read("allowedRoutes", "allowed_routes"));
  const policyVersion = text(read("policyVersion", "policy_version"));
  if (
    !taskId ||
    !policyVersion ||
    freeOnly === null ||
    !allowedRoutes ||
    allowedRoutes.length === 0
  ) {
    return { enabled: true, reason: "MALFORMED_POLICY" };
  }
  if (!isRole(role)) return { enabled: true, reason: "UNKNOWN_ROLE" };
  if (!isPrivacyClass(privacyClass)) return { enabled: true, reason: "UNKNOWN_PRIVACY_CLASS" };
  return {
    enabled: true,
    metadata: { taskId, role, privacyClass, freeOnly, allowedRoutes, policyVersion },
  };
}

function routeId(route: Pick<OdysseusRouteApproval, "provider" | "model">): string {
  return `${route.provider}/${route.model}`;
}

export function evaluateOdysseusPolicy(
  parsed: ReturnType<typeof parseOdysseusMetadata>,
  approvals: readonly OdysseusRouteApproval[] = DEFAULT_ODYSSEUS_APPROVALS,
  requestedRoute?: string | null
): PolicyDecision {
  if (!parsed.enabled)
    return {
      result: "disabled",
      reason: null,
      metadata: null,
      selectedRoute: null,
      candidates: [],
    };
  if ("reason" in parsed)
    return {
      result: "denied",
      reason: parsed.reason,
      metadata: null,
      selectedRoute: null,
      candidates: [],
    };
  const { metadata } = parsed;
  if (metadata.privacyClass === "sensitive") {
    return {
      result: "denied",
      reason: "PRIVACY_DENIED",
      metadata,
      selectedRoute: null,
      candidates: [],
    };
  }
  if (metadata.privacyClass === "private_source") {
    const privateCandidates = approvals.filter((route) => route.privateSourceApproved === true);
    if (privateCandidates.length === 0) {
      return {
        result: "denied",
        reason: "PRIVACY_DENIED",
        metadata,
        selectedRoute: null,
        candidates: [],
      };
    }
  }
  const candidates = approvals.filter((route) => {
    const exact =
      route.role === metadata.role && route.enabled && route.approvalStatus === "approved";
    const explicitlyAllowed = metadata.allowedRoutes.includes(routeId(route));
    const free =
      route.pricing === "free_api_tier" ||
      (route.pricing === "signup_credit_only" && route.signupCreditAllowed === true);
    const available = route.providerAvailable !== false && route.quotaAvailable !== false;
    const privacy = metadata.privacyClass === "public" || route.privateSourceApproved === true;
    return exact && explicitlyAllowed && privacy && available && (!metadata.freeOnly || free);
  });
  const requested = requestedRoute
    ? candidates.filter((route) => routeId(route) === requestedRoute)
    : candidates;
  if (requestedRoute && requested.length === 0) {
    const known = approvals.some((route) => routeId(route) === requestedRoute);
    const quota = approvals.some(
      (route) => routeId(route) === requestedRoute && route.quotaAvailable === false
    );
    const unavailable = approvals.some(
      (route) => routeId(route) === requestedRoute && route.providerAvailable === false
    );
    return {
      result: "denied",
      reason: quota
        ? "FREE_QUOTA_EXHAUSTED"
        : unavailable
          ? "PROVIDER_UNAVAILABLE"
          : known
            ? metadata.freeOnly
              ? "NO_APPROVED_FREE_ROUTE"
              : "POLICY_DENIED"
            : "NO_APPROVED_FREE_ROUTE",
      metadata,
      selectedRoute: null,
      candidates,
    };
  }
  if (candidates.length === 0)
    return {
      result: "denied",
      reason: "NO_APPROVED_FREE_ROUTE",
      metadata,
      selectedRoute: null,
      candidates: [],
    };
  return {
    result: "allowed",
    reason: null,
    metadata,
    selectedRoute: requested[0] ?? candidates[0],
    candidates,
  };
}
