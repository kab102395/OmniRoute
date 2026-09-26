/**
 * Freebuff account usage.
 *
 * The official Freebuff client reads this account-wide usage endpoint. Keep the
 * token server-side and return only the normalized quota fields consumed by the
 * dashboard; never include the credential in errors or telemetry.
 */

import { type UsageQuota } from "./quota.ts";

const FREEBUFF_USAGE_URL = "https://www.codebuff.com/api/v1/usage";
const DEFAULT_FREEBUCKS_DAILY_LIMIT = 100;

type FreebuffUsageResponse = {
  usage?: unknown;
  remainingBalance?: unknown;
  balanceBreakdown?: {
    free?: unknown;
    paid?: unknown;
    ad?: unknown;
    referral?: unknown;
    admin?: unknown;
  };
  next_quota_reset?: unknown;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function buildFreebucksQuota(data: FreebuffUsageResponse): UsageQuota | null {
  const remaining =
    finiteNumber(data.remainingBalance) ?? finiteNumber(data.balanceBreakdown?.free);
  if (remaining === null) return null;

  const reportedUsage = finiteNumber(data.usage);
  const total =
    reportedUsage !== null
      ? Math.max(DEFAULT_FREEBUCKS_DAILY_LIMIT, reportedUsage + remaining)
      : DEFAULT_FREEBUCKS_DAILY_LIMIT;
  const used = Math.max(0, total - remaining);

  return {
    used,
    total,
    remaining,
    remainingPercentage: total > 0 ? Math.round((remaining / total) * 100) : 0,
    resetAt: typeof data.next_quota_reset === "string" ? data.next_quota_reset : null,
    unlimited: false,
    displayName: "Freebucks (daily)",
  };
}

export async function getFreebuffUsage(apiKey: string) {
  if (!apiKey) return { message: "Freebuff Auth Token not available. Add a token to view usage." };

  try {
    const response = await fetch(FREEBUFF_USAGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprintId: "omniroute-usage", authToken: apiKey }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return { message: `Freebuff usage unavailable (${response.status})` };
    }

    const data = (await response.json()) as FreebuffUsageResponse;
    const freebucks = buildFreebucksQuota(data);
    if (!freebucks) return { message: "Freebuff returned no Freebucks balance." };

    return {
      plan: "Freebuff",
      quotas: { freebucks },
      accountUsage: {
        remainingBalance: freebucks.remaining,
        resetAt: freebucks.resetAt,
        balanceBreakdown: data.balanceBreakdown || null,
      },
    };
  } catch {
    return { message: "Freebuff usage request failed" };
  }
}

export { buildFreebucksQuota };
