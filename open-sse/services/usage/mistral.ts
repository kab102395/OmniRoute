/**
 * Mistral usage and rate-limit snapshot.
 *
 * Mistral's organization billing and per-model limit APIs require a separate
 * Admin API key. A normal Studio API key does, however, receive the current
 * rate-limit headers on API responses. Probe the public models endpoint so the
 * Limits dashboard can show the live request/token window without claiming
 * access to billing data that the key cannot read.
 */

import { parseResetTime, type UsageQuota } from "./quota.ts";

function readHeader(headers: Headers, ...names: string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value.trim()) return value.trim();
  }
  return null;
}

function numericHeader(headers: Headers, ...names: string[]): number | null {
  const raw = readHeader(headers, ...names);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function buildQuota(
  headers: Headers,
  limitNames: string[],
  remainingNames: string[],
  resetNames: string[],
  displayName: string
): UsageQuota | null {
  const total = numericHeader(headers, ...limitNames);
  const remaining = numericHeader(headers, ...remainingNames);
  if (total === null || remaining === null || total <= 0) return null;

  const boundedRemaining = Math.min(total, remaining);
  return {
    used: Math.max(total - boundedRemaining, 0),
    total,
    remaining: boundedRemaining,
    remainingPercentage: Math.round((boundedRemaining / total) * 100),
    resetAt: parseResetTime(readHeader(headers, ...resetNames)),
    unlimited: false,
    displayName,
  };
}

export function parseMistralRateLimitHeaders(headers: Headers): {
  quotas: Record<string, UsageQuota>;
  hasHeaders: boolean;
} {
  const quotas: Record<string, UsageQuota> = {};
  const requestQuota = buildQuota(
    headers,
    ["x-ratelimit-limit-requests", "x-ratelimit-limit"],
    ["x-ratelimit-remaining-requests", "x-ratelimit-remaining"],
    ["x-ratelimit-reset-requests", "x-ratelimit-reset"],
    "Mistral requests (rate window)"
  );
  const tokenQuota = buildQuota(
    headers,
    ["x-ratelimit-limit-tokens", "x-ratelimit-limit-token"],
    ["x-ratelimit-remaining-tokens", "x-ratelimit-remaining-token"],
    ["x-ratelimit-reset-tokens", "x-ratelimit-reset-token"],
    "Mistral tokens (rate window)"
  );

  if (requestQuota) quotas.requests = requestQuota;
  if (tokenQuota) quotas.tokens = tokenQuota;
  return { quotas, hasHeaders: Boolean(requestQuota || tokenQuota) };
}

export async function getMistralUsage(apiKey: string) {
  if (!apiKey) {
    return { message: "Mistral API key not available. Add a key to view usage." };
  }

  try {
    const response = await fetch("https://api.mistral.ai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const { quotas, hasHeaders } = parseMistralRateLimitHeaders(response.headers);

    if (!response.ok) {
      return {
        quotas: hasHeaders ? quotas : null,
        plan: "Mistral",
        message: `Mistral models probe returned HTTP ${response.status}. Check the API key or workspace.`,
      };
    }

    return {
      plan: "Mistral API",
      quotas: hasHeaders ? quotas : null,
      message: hasHeaders
        ? "Live rate-window limits from Mistral response headers. Monthly billing and per-model limits require a Mistral Admin API key."
        : "Mistral connected. This API key response did not include rate-limit headers; monthly billing and per-model limits require a Mistral Admin API key.",
    };
  } catch {
    return {
      plan: "Mistral API",
      quotas: null,
      message: "Mistral usage probe failed; the connection may still be usable for inference.",
    };
  }
}
