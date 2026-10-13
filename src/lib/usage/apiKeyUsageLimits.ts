import { getDbInstance } from "@/lib/db/core";
import type { ProviderLimitsCacheEntry } from "@/lib/db/providerLimits";
import { getProviderQuotaWindowStartIso } from "@/lib/db/quotaResetEvents";
import { toNumber } from "@/shared/utils/numeric";
import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const FORTALEZA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiKeyUsageLimitMetadata {
  id: string;
  allowedConnections?: string[] | null;
  preferredProvider?: string | null;
  usageLimitEnabled?: boolean;
  dailyUsageLimitUsd?: number | null;
  weeklyUsageLimitUsd?: number | null;
}

export interface ApiKeyUsageLimitStatus {
  enabled: boolean;
  dailyLimitUsd: number | null;
  weeklyLimitUsd: number | null;
  dailySpentUsd: number;
  weeklySpentUsd: number;
  dailyWindowStartIso: string;
  dailyResetAtIso: string;
  weeklyWindowStartIso: string;
  weeklyResetAtIso: string | null;
  dailyExceeded: boolean;
  weeklyExceeded: boolean;
  dailyPricingUnknown?: boolean;
  weeklyPricingUnknown?: boolean;
}

export interface ApiKeyUsageLimitDeps {
  now?: () => number;
  getProviderConnectionById?: (connectionId: string) => Promise<unknown>;
  getProviderConnections?: (filter?: Record<string, unknown>) => Promise<unknown[]>;
  getProviderLimitsCache?: (connectionId: string) => ProviderLimitsCacheEntry | null;
  getAllProviderLimitsCache?: () => Record<string, ProviderLimitsCacheEntry>;
}

interface WeeklyResetCandidate {
  connectionId: string;
  provider: string;
  resetAtIso: string;
  observedWindowStartIso: string | null;
}

interface QuotaSnapshotRow {
  remainingPercentage: number | null;
  nextResetAt: string | null;
  createdAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeLimitUsd(value: unknown): number | null {
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

function expandDecimal(value: string): string | null {
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const [coefficient, exponentText] = value.toLowerCase().split("e");
  const exponent = Number(exponentText ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const point = unsigned.indexOf(".");
  const digits = unsigned.replace(".", "");
  const decimalIndex = (point < 0 ? unsigned.length : point) + exponent;
  const expanded =
    decimalIndex <= 0
      ? `0.${"0".repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${"0".repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  return `${negative ? "-" : ""}${expanded}`;
}

function addUsdDecimals(values: readonly string[]): string {
  const normalized = values.map((value) => expandDecimal(value) ?? "0");
  const scale = normalized.reduce(
    (maximum, value) => Math.max(maximum, value.split(".")[1]?.length ?? 0),
    0
  );
  const total = normalized.reduce((sum, value) => {
    const [whole, fraction = ""] = value.split(".");
    const sign = whole.startsWith("-") ? -1n : 1n;
    const digits = `${whole.replace("-", "")}${fraction.padEnd(scale, "0")}`;
    return sum + sign * BigInt(digits || "0");
  }, 0n);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function compareUsdDecimals(left: string, right: string): number {
  const normalizedLeft = expandDecimal(left);
  const normalizedRight = expandDecimal(right);
  if (normalizedLeft === null || normalizedRight === null) return 0;
  const scale = Math.max(
    normalizedLeft.split(".")[1]?.length ?? 0,
    normalizedRight.split(".")[1]?.length ?? 0
  );
  const toUnits = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    const sign = whole.startsWith("-") ? -1n : 1n;
    return sign * BigInt(`${whole.replace("-", "")}${fraction.padEnd(scale, "0")}` || "0");
  };
  const leftUnits = toUnits(normalizedLeft);
  const rightUnits = toUnits(normalizedRight);
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not configured";
  return `$${value.toFixed(2)}`;
}

function getUsagePercent(spentUsd: number, limitUsd: number | null): number | null {
  if (limitUsd === null || !Number.isFinite(limitUsd) || limitUsd <= 0) return null;
  return (spentUsd / limitUsd) * 100;
}

function formatUsagePercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "Unavailable";
  return `${Math.round(percent)}%`;
}

function formatLeftPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "Unavailable";
  return `${Math.round(100 - clampPercent(percent))}% left`;
}

function formatResetIn(resetAt: string | null, now = Date.now()): string {
  if (!resetAt) return "unknown";
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return "unknown";

  const deltaMs = resetMs - now;
  if (deltaMs <= 0) return "now";

  const minuteMs = 60_000;
  const totalMinutes = Math.max(1, Math.ceil(deltaMs / minuteMs));
  const dayMinutes = 24 * 60;
  const days = Math.floor(totalMinutes / dayMinutes);
  const hours = Math.floor((totalMinutes % dayMinutes) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function resetDay(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function getFortalezaDayStartIso(nowMs = Date.now()): string {
  const fortalezaLocal = new Date(nowMs - FORTALEZA_UTC_OFFSET_MS);
  return new Date(
    Date.UTC(
      fortalezaLocal.getUTCFullYear(),
      fortalezaLocal.getUTCMonth(),
      fortalezaLocal.getUTCDate(),
      3,
      0,
      0,
      0
    )
  ).toISOString();
}

export function getFortalezaDayResetIso(nowMs = Date.now()): string {
  return new Date(Date.parse(getFortalezaDayStartIso(nowMs)) + DAY_MS).toISOString();
}

export function getRollingWeekStartIso(nowMs = Date.now()): string {
  return new Date(nowMs - WEEK_MS).toISOString();
}

function normalizeQuotaName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeProvider(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (normalized === "cc" || normalized === "claude-code") return "claude";
  return normalized;
}

function findWeeklyQuotaResetAt(quotas: unknown, nowMs: number): string | null {
  const quotaEntries: Array<[string, Record<string, unknown>]> = [];
  if (Array.isArray(quotas)) {
    for (const item of quotas) {
      const quota = asRecord(item);
      if (!quota) continue;
      const name = typeof quota.name === "string" ? quota.name : "";
      quotaEntries.push([name, quota]);
    }
  } else {
    const quotaMap = asRecord(quotas);
    if (quotaMap) {
      for (const [name, value] of Object.entries(quotaMap)) {
        const quota = asRecord(value);
        if (quota) quotaEntries.push([name, quota]);
      }
    }
  }

  for (const [name, quota] of quotaEntries) {
    const label = normalizeQuotaName(`${name} ${typeof quota.name === "string" ? quota.name : ""}`);
    if (!label) continue;
    const isWeekly = label.includes("weekly") || label.includes("7d");
    if (!isWeekly || label.includes("sonnet")) continue;
    const resetAt = typeof quota.resetAt === "string" && quota.resetAt.trim() ? quota.resetAt : "";
    const resetMs = Date.parse(resetAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs) {
      return new Date(resetMs).toISOString();
    }
  }

  return null;
}

function connectionFromValue(value: unknown): { id: string; provider: string } | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id : "";
  const provider = typeof record.provider === "string" ? record.provider : "";
  if (!id || !provider || record.isActive === false) return null;
  return { id, provider };
}

function isWeeklyQuotaResetSnapshot(row: QuotaSnapshotRow, targetResetAtIso: string): boolean {
  const targetDay = resetDay(targetResetAtIso);
  if (!targetDay) return false;
  return resetDay(row.nextResetAt) === targetDay;
}

function getObservedWeeklyWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs: number
): string | null {
  if (!connectionId || !targetResetAtIso) return null;

  try {
    const rows = getDbInstance()
      .prepare(
        `
        SELECT
          remaining_percentage as remainingPercentage,
          next_reset_at as nextResetAt,
          created_at as createdAt
        FROM quota_snapshots
        WHERE connection_id = @connectionId
          AND LOWER(window_key) LIKE '%weekly%'
          AND LOWER(window_key) NOT LIKE '%sonnet%'
          AND created_at <= @nowIso
        ORDER BY created_at ASC, id ASC
      `
      )
      .all({ connectionId, nowIso: new Date(nowMs).toISOString() }) as QuotaSnapshotRow[];

    let observedStartIso: string | null = null;
    let previousUsedPercent: number | null = null;

    for (const row of rows) {
      if (!row.createdAt || !isWeeklyQuotaResetSnapshot(row, targetResetAtIso)) continue;
      const remaining = toNumber(row.remainingPercentage);
      const usedPercent = clampPercent(100 - remaining);

      if (!observedStartIso) {
        observedStartIso = row.createdAt;
      } else if (previousUsedPercent !== null) {
        const droppedToResetFloor = usedPercent <= 1 && previousUsedPercent > usedPercent;
        const significantDrop = previousUsedPercent - usedPercent >= 5;
        if (droppedToResetFloor || significantDrop) {
          observedStartIso = row.createdAt;
        }
      }

      previousUsedPercent = usedPercent;
    }

    return observedStartIso;
  } catch {
    return null;
  }
}

// Prefer the persisted, provider-observed window start (recorded by
// quotaResetEvents on real reset transitions); fall back to inferring it from
// historical snapshots when no observed event is available yet.
function getWeeklyWindowStartIso(
  connectionId: string,
  targetResetAtIso: string,
  nowMs: number
): string | null {
  return (
    getProviderQuotaWindowStartIso(connectionId, targetResetAtIso, nowMs) ??
    getObservedWeeklyWindowStartIso(connectionId, targetResetAtIso, nowMs)
  );
}

async function resolveDeps(deps: ApiKeyUsageLimitDeps): Promise<Required<ApiKeyUsageLimitDeps>> {
  const providers =
    deps.getProviderConnectionById && deps.getProviderConnections
      ? null
      : await import("@/lib/db/providers");
  const providerLimits =
    deps.getProviderLimitsCache && deps.getAllProviderLimitsCache
      ? null
      : await import("@/lib/db/providerLimits");

  return {
    now: deps.now ?? Date.now,
    getProviderConnectionById:
      deps.getProviderConnectionById ?? providers!.getProviderConnectionById,
    getProviderConnections: deps.getProviderConnections ?? providers!.getProviderConnections,
    getProviderLimitsCache: deps.getProviderLimitsCache ?? providerLimits!.getProviderLimitsCache,
    getAllProviderLimitsCache:
      deps.getAllProviderLimitsCache ?? providerLimits!.getAllProviderLimitsCache,
  };
}

async function getProviderWeeklyWindow(
  metadata: ApiKeyUsageLimitMetadata,
  deps: Required<ApiKeyUsageLimitDeps>,
  nowMs: number
): Promise<{ resetAtIso: string | null; windowStartIso: string | null }> {
  const allowedConnections = Array.isArray(metadata.allowedConnections)
    ? metadata.allowedConnections.filter((id) => typeof id === "string" && id.trim())
    : [];

  const resetCandidates: WeeklyResetCandidate[] = [];
  if (allowedConnections.length > 0) {
    for (const connectionId of allowedConnections) {
      const connection = connectionFromValue(await deps.getProviderConnectionById(connectionId));
      if (!connection) continue;
      const resetAt = findWeeklyQuotaResetAt(
        deps.getProviderLimitsCache(connection.id)?.quotas,
        nowMs
      );
      if (resetAt) {
        resetCandidates.push({
          connectionId: connection.id,
          provider: connection.provider,
          resetAtIso: resetAt,
          observedWindowStartIso: getWeeklyWindowStartIso(connection.id, resetAt, nowMs),
        });
      }
    }
  } else {
    const caches = deps.getAllProviderLimitsCache();
    const connections = await deps.getProviderConnections({ isActive: true });
    for (const rawConnection of connections) {
      const connection = connectionFromValue(rawConnection);
      if (!connection) continue;
      const resetAt = findWeeklyQuotaResetAt(caches[connection.id]?.quotas, nowMs);
      if (resetAt) {
        resetCandidates.push({
          connectionId: connection.id,
          provider: connection.provider,
          resetAtIso: resetAt,
          observedWindowStartIso: getWeeklyWindowStartIso(connection.id, resetAt, nowMs),
        });
      }
    }
  }

  const preferredProvider = normalizeProvider(metadata.preferredProvider);
  const scopedCandidates = preferredProvider
    ? resetCandidates.filter(
        (candidate) => normalizeProvider(candidate.provider) === preferredProvider
      )
    : [];
  const candidates = scopedCandidates.length > 0 ? scopedCandidates : resetCandidates;
  const selected =
    candidates
      .sort((left, right) => Date.parse(left.resetAtIso) - Date.parse(right.resetAtIso))
      .at(0) ?? null;
  return {
    resetAtIso: selected?.resetAtIso ?? null,
    windowStartIso: selected?.observedWindowStartIso ?? null,
  };
}

async function getApiKeyUsdSpendSince(
  apiKeyId: string,
  sinceIso: string
): Promise<{ spentUsd: number; spentUsdExact: string; pricingUnknown: boolean }> {
  if (!apiKeyId) return { spentUsd: 0, spentUsdExact: "0", pricingUnknown: false };
  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT accounting_json as accountingJson, success
      FROM usage_history
      WHERE api_key_id = @apiKeyId
        AND timestamp >= @sinceIso
    `
    )
    .all({ apiKeyId, sinceIso }) as Array<{ accountingJson: string | null; success: number }>;

  const knownAmounts: string[] = [];
  let pricingUnknown = false;
  for (const row of rows) {
    let accounting: Record<string, unknown> | null = null;
    try {
      accounting = row.accountingJson
        ? (JSON.parse(row.accountingJson) as Record<string, unknown>)
        : null;
    } catch {
      accounting = null;
    }
    const kind = accounting?.kind;
    // A failed gateway request can still incur a provider charge. Count it when
    // a provider receipt confirms that charge; failures without a billable
    // receipt are not treated as either spend or unknown priced usage.
    if (row.success !== 1 && kind !== "provider_reported_billed_cost") continue;
    if (kind === "zero_cost") continue;
    const amount = accounting?.amountUsd;
    const exactAmount =
      typeof accounting?.amountUsdExact === "string"
        ? expandDecimal(accounting.amountUsdExact)
        : typeof amount === "number" && Number.isFinite(amount) && amount >= 0
          ? expandDecimal(String(amount))
          : null;
    if (
      (kind === "estimated_cost" || kind === "provider_reported_billed_cost") &&
      accounting?.currency === "USD" &&
      exactAmount !== null &&
      compareUsdDecimals(exactAmount, "0") >= 0
    ) {
      knownAmounts.push(exactAmount);
    } else {
      // Legacy records and usage without a persisted pricing snapshot cannot
      // safely be repriced using a catalog that may have changed since then.
      pricingUnknown = true;
    }
  }

  const spentUsdExact = addUsdDecimals(knownAmounts);
  return {
    spentUsd: Number(spentUsdExact),
    spentUsdExact,
    pricingUnknown,
  };
}

export async function getApiKeyUsageLimitStatus(
  metadata: ApiKeyUsageLimitMetadata,
  deps: ApiKeyUsageLimitDeps = {}
): Promise<ApiKeyUsageLimitStatus> {
  const resolvedDeps = await resolveDeps(deps);
  const now = resolvedDeps.now();
  const dailyWindowStartIso = getFortalezaDayStartIso(now);
  const dailyResetAtIso = getFortalezaDayResetIso(now);
  const weeklyWindow = await getProviderWeeklyWindow(metadata, resolvedDeps, now);
  const weeklyResetAtIso = weeklyWindow.resetAtIso;
  const weeklyWindowStartIso = weeklyWindow.windowStartIso
    ? weeklyWindow.windowStartIso
    : weeklyResetAtIso
      ? new Date(Date.parse(weeklyResetAtIso) - WEEK_MS).toISOString()
      : getRollingWeekStartIso(now);
  const dailyLimitUsd = normalizeLimitUsd(metadata.dailyUsageLimitUsd);
  const weeklyLimitUsd = normalizeLimitUsd(metadata.weeklyUsageLimitUsd);
  const enabled = metadata.usageLimitEnabled === true;

  const [dailySpend, weeklySpend] = await Promise.all([
    getApiKeyUsdSpendSince(metadata.id, dailyWindowStartIso),
    getApiKeyUsdSpendSince(metadata.id, weeklyWindowStartIso),
  ]);
  const { spentUsd: dailySpentUsd, pricingUnknown: dailyPricingUnknown } = dailySpend;
  const { spentUsd: weeklySpentUsd, pricingUnknown: weeklyPricingUnknown } = weeklySpend;

  return {
    enabled,
    dailyLimitUsd,
    weeklyLimitUsd,
    dailySpentUsd,
    weeklySpentUsd,
    dailyWindowStartIso,
    dailyResetAtIso,
    weeklyWindowStartIso,
    weeklyResetAtIso,
    dailyExceeded:
      enabled &&
      dailyLimitUsd !== null &&
      (dailyPricingUnknown ||
        compareUsdDecimals(dailySpend.spentUsdExact, String(dailyLimitUsd)) >= 0),
    weeklyExceeded:
      enabled &&
      weeklyLimitUsd !== null &&
      (weeklyPricingUnknown ||
        compareUsdDecimals(weeklySpend.spentUsdExact, String(weeklyLimitUsd)) >= 0),
    dailyPricingUnknown,
    weeklyPricingUnknown,
  };
}

export function buildApiKeyUsageLimitText(
  status: ApiKeyUsageLimitStatus,
  now = Date.now()
): string {
  return [
    "Daily quota",
    formatUsd(status.dailyLimitUsd),
    "Daily spent",
    status.dailyPricingUnknown
      ? "Unknown (unpriced usage exists)"
      : formatUsd(status.dailySpentUsd),
    "Daily used",
    status.dailyPricingUnknown
      ? "Unknown"
      : formatUsagePercent(getUsagePercent(status.dailySpentUsd, status.dailyLimitUsd)),
    `Resets in ${formatResetIn(status.dailyResetAtIso, now)}`,
    "",
    "Weekly quota",
    formatUsd(status.weeklyLimitUsd),
    "Weekly spent",
    status.weeklyPricingUnknown
      ? "Unknown (unpriced usage exists)"
      : formatUsd(status.weeklySpentUsd),
    "Weekly used",
    status.weeklyPricingUnknown
      ? "Unknown"
      : formatUsagePercent(getUsagePercent(status.weeklySpentUsd, status.weeklyLimitUsd)),
    `Resets in ${formatResetIn(status.weeklyResetAtIso, now)}`,
  ].join("\n");
}

export function buildApiKeyUsageLimitPercentText(
  status: ApiKeyUsageLimitStatus,
  now = Date.now()
): string {
  return [
    "Daily",
    status.dailyPricingUnknown
      ? "Unknown"
      : formatLeftPercent(getUsagePercent(status.dailySpentUsd, status.dailyLimitUsd)),
    `⏱ reset in ${formatResetIn(status.dailyResetAtIso, now)}`,
    "",
    "Weekly",
    status.weeklyPricingUnknown
      ? "Unknown"
      : formatLeftPercent(getUsagePercent(status.weeklySpentUsd, status.weeklyLimitUsd)),
    `⏱ reset in ${formatResetIn(status.weeklyResetAtIso, now)}`,
  ].join("\n");
}

function buildUsageLimitExceededMessage(
  status: ApiKeyUsageLimitStatus,
  now = Date.now(),
  options: { showUsd?: boolean } = {}
): string {
  const showUsd = options.showUsd !== false;
  if (status.dailyExceeded && status.dailyPricingUnknown) {
    return "This API key has usage with unknown pricing in its daily budget window. Requests are blocked until the window resets or the usage record is reconciled.";
  }
  if (status.weeklyExceeded && status.weeklyPricingUnknown) {
    return "This API key has usage with unknown pricing in its weekly budget window. Requests are blocked until the window resets or the usage record is reconciled.";
  }
  if (status.dailyExceeded && status.dailyLimitUsd !== null) {
    const percent = formatUsagePercent(getUsagePercent(status.dailySpentUsd, status.dailyLimitUsd));
    if (!showUsd) {
      return `This API key reached its daily usage quota (${percent}). Resets in ${formatResetIn(status.dailyResetAtIso, now)}. Choose another allowed model after reset.`;
    }
    return `This API key reached its daily USD usage quota (${formatUsd(status.dailySpentUsd)} of ${formatUsd(status.dailyLimitUsd)}, ${percent}). Resets in ${formatResetIn(status.dailyResetAtIso, now)}. Choose another allowed model after reset.`;
  }
  if (status.weeklyExceeded && status.weeklyLimitUsd !== null) {
    const percent = formatUsagePercent(
      getUsagePercent(status.weeklySpentUsd, status.weeklyLimitUsd)
    );
    if (!showUsd) {
      return `This API key reached its weekly usage quota (${percent}). Resets in ${formatResetIn(status.weeklyResetAtIso, now)}. Choose another allowed model after reset.`;
    }
    return `This API key reached its weekly USD usage quota (${formatUsd(status.weeklySpentUsd)} of ${formatUsd(status.weeklyLimitUsd)}, ${percent}). Resets in ${formatResetIn(status.weeklyResetAtIso, now)}. Choose another allowed model after reset.`;
  }
  return showUsd
    ? "This API key reached its USD usage quota. Choose another allowed model or wait for quota reset."
    : "This API key reached its usage quota. Choose another allowed model or wait for quota reset.";
}

function isAnthropicMessagesRequest(request: Request): boolean {
  if (request.headers.has("anthropic-version")) return true;
  try {
    return new URL(request.url).pathname.endsWith("/v1/messages");
  } catch {
    return false;
  }
}

export function buildApiKeyUsageLimitRejection(
  request: Request,
  status: ApiKeyUsageLimitStatus,
  now = Date.now(),
  options: { showUsd?: boolean } = {}
): Response {
  const message = sanitizeErrorMessage(buildUsageLimitExceededMessage(status, now, options));
  if (isAnthropicMessagesRequest(request)) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message,
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(JSON.stringify(buildErrorBody(400, message)), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export async function buildApiKeyUsageLimitPolicyRejection(
  request: Request,
  metadata: ApiKeyUsageLimitMetadata
): Promise<Response | null> {
  const status = await getApiKeyUsageLimitStatus(metadata);
  if (!status.enabled || (!status.dailyExceeded && !status.weeklyExceeded)) return null;
  return buildApiKeyUsageLimitRejection(request, status, Date.now(), {
    showUsd: false,
  });
}
