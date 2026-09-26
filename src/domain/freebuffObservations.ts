import { saveQuotaSnapshot } from "@/lib/db/quotaSnapshots";
import { createLogger } from "@/shared/utils/logger";
import {
  deriveRemainingSessionMs,
  stableFreebuffInstanceRef,
} from "@omniroute/open-sse/executors/freebuffProtocol.ts";

const log = createLogger("provider:freebuff-observations");

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeString(value: unknown, maxLength = 180): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  return /^[\w./:+-]+$/.test(value) ? value : null;
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null;
}

/** Persist one authoritative session/resource response in quota_snapshots.raw_data. */
export function persistFreebuffResourceObservation(args: {
  connectionId?: string;
  response: unknown;
  observedAt?: number;
}): void {
  const { connectionId, response } = args;
  if (!connectionId || !/^[\w-]{1,128}$/.test(connectionId)) return;
  const session = objectValue(response);
  if (!session || !["active", "none", "ended"].includes(String(session.status))) return;

  const now = args.observedAt ?? Date.now();
  const expiresAt = safeTimestamp(session.expiresAt);
  const admittedAt = safeTimestamp(session.admittedAt);
  const observedModel = safeString(session.model);
  const instanceRef = stableFreebuffInstanceRef(session.instanceId);
  const freebucks = objectValue(session.freebucks);
  const daily = objectValue(freebucks?.daily);
  const wallet = objectValue(freebucks?.wallet);
  const prices = objectValue(freebucks?.prices);
  const dailyLimit = finiteNumber(daily?.limit);
  const dailyRemaining = finiteNumber(daily?.remaining);
  const dailyPercentRemaining =
    dailyLimit !== null && dailyLimit > 0 && dailyRemaining !== null
      ? Math.max(0, Math.min(100, (dailyRemaining / dailyLimit) * 100))
      : null;
  const safePrices: Record<string, number> = {};
  for (const [id, price] of Object.entries(prices ?? {})) {
    const safeId = safeString(id);
    const safePrice = finiteNumber(price);
    if (safeId && safePrice !== null && safePrice >= 0) safePrices[safeId] = safePrice;
  }
  const totalBalance = finiteNumber(freebucks?.balance);
  const capacityByModel = Object.fromEntries(
    Object.entries(safePrices).map(([id, price]) => {
      const state =
        freebucks?.quotaExempt === true || (dailyRemaining !== null && dailyRemaining >= price)
          ? "available"
          : totalBalance === null || dailyRemaining === null
            ? "unknown"
            : totalBalance >= price
              ? "consent_required"
              : "exhausted";
      return [id, state];
    })
  );
  const rawData = {
    provenance: "OBSERVED_UPSTREAM",
    observed_at: new Date(now).toISOString(),
    session: {
      status: safeString(session.status),
      model: observedModel,
      instance_ref: instanceRef,
      admitted_at: admittedAt,
      expires_at: expiresAt,
      observed_remaining_ms: finiteNumber(session.remainingMs),
      remaining_session_ms: expiresAt === null ? null : deriveRemainingSessionMs(expiresAt, now),
      remaining_session_ms_provenance: "DERIVED",
    },
    freebucks: freebucks
      ? {
          balance: finiteNumber(freebucks.balance),
          daily: daily
            ? {
                limit: dailyLimit,
                spent: finiteNumber(daily.spent),
                remaining: dailyRemaining,
                reset_at: safeTimestamp(daily.resetAt),
                reset_time_zone: safeString(daily.resetTimeZone, 100),
                percent_remaining: dailyPercentRemaining,
                percent_remaining_provenance: "DERIVED",
              }
            : null,
          wallet: wallet
            ? {
                balance: finiteNumber(wallet.balance),
                monthly_bonus: finiteNumber(wallet.monthlyBonus),
                next_bonus_at: safeTimestamp(wallet.nextBonusAt),
              }
            : null,
          prices: safePrices,
          capacity_by_model: capacityByModel,
          capacity_by_model_provenance: "DERIVED",
        }
      : null,
  };

  try {
    saveQuotaSnapshot({
      provider: "freebuff",
      connection_id: connectionId,
      window_key: "freebuff:resource:session",
      remaining_percentage: dailyPercentRemaining,
      // The aggregate flag is true only if every metered model has an observed
      // insufficient balance. The namespaced row is excluded from routing
      // cache hydration in either case.
      is_exhausted:
        Object.keys(capacityByModel).length > 0 &&
        Object.values(capacityByModel).every((state) => state === "exhausted")
          ? 1
          : 0,
      next_reset_at: safeTimestamp(daily?.resetAt),
      window_duration_ms: null,
      raw_data: JSON.stringify(rawData),
    });
  } catch (error) {
    log.warn(
      { connectionId, model: observedModel, error },
      "failed to persist session/resource observation"
    );
  }
}
