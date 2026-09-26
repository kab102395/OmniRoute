import { createHash } from "node:crypto";

export type FreebuffAdmissionClassification =
  | "ADMITTED"
  | "NO_CAPACITY"
  | "ACCOUNT_RESTRICTED"
  | "MODEL_RESTRICTED"
  | "CONSENT_REQUIRED"
  | "TRANSIENT_PROVIDER_FAILURE"
  | "SESSION_CONFLICT"
  | "UNKNOWN";

const STATUS_CLASSIFICATION: Record<string, FreebuffAdmissionClassification> = {
  active: "ADMITTED",
  ip_capped: "NO_CAPACITY",
  rate_limited: "NO_CAPACITY",
  spend_limited: "NO_CAPACITY",
  purchase_capacity: "NO_CAPACITY",
  premium_slot_taken: "NO_CAPACITY",
  banned: "ACCOUNT_RESTRICTED",
  country_blocked: "ACCOUNT_RESTRICTED",
  model_unavailable: "MODEL_RESTRICTED",
  consent_required: "CONSENT_REQUIRED",
  model_locked: "SESSION_CONFLICT",
  ended: "SESSION_CONFLICT",
  superseded: "SESSION_CONFLICT",
  purchase_in_use: "SESSION_CONFLICT",
  purchase_claim_released: "SESSION_CONFLICT",
};

export function classifyFreebuffAdmission(
  status: unknown,
  httpStatus: number
): FreebuffAdmissionClassification {
  if (typeof status === "string" && STATUS_CLASSIFICATION[status]) {
    return STATUS_CLASSIFICATION[status];
  }
  if (httpStatus === 408 || httpStatus >= 500) return "TRANSIENT_PROVIDER_FAILURE";
  return "UNKNOWN";
}

export function buildFreebuffAdmissionHeaders(token: string, model: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "x-freebuff-model": model,
    // Match the official single-session client defaults. Zero explicitly
    // declines wallet spending unless the caller has supplied consent.
    "x-freebuff-first-tab-discount": "0",
    "x-freebuff-wallet-spend-limit": "0",
  });
}

export function deriveRemainingSessionMs(expiresAt: unknown, nowMs = Date.now()): number | null {
  if (typeof expiresAt !== "string") return null;
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, expiryMs - nowMs);
}

export function stableFreebuffInstanceRef(instanceId: unknown): string | null {
  if (typeof instanceId !== "string" || instanceId.length === 0) return null;
  return createHash("sha256").update(instanceId).digest("hex").slice(0, 16);
}

export function isFreebuffActiveAdmission(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  return (
    session.status === "active" &&
    typeof session.instanceId === "string" &&
    session.instanceId.length > 0
  );
}
