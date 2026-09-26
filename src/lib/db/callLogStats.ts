import { getDbInstance } from "./core";

/**
 * Aggregation queries over `call_logs` extracted from route handlers.
 *
 * Hard Rule #5: routes must not embed raw SQL — these queries live here so the
 * /api/provider-metrics, /api/search/stats, and /api/v1/search/analytics routes
 * can delegate. Read-only aggregation; no writes.
 *
 * Sliced out of #3500 (call_logs cluster).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderMetricRow {
  provider: string;
  totalRequests: number;
  totalSuccesses: number;
  avgLatencyMs: number;
  lastRequestAt: string | null;
  lastErrorAt: string | null;
  lastStatus: number | null;
  lastErrorStatus: number | null;
}

/** One provider's traffic over a bounded window. See `getProviderUsageSince`. */
export interface ProviderUsageRow {
  provider: string;
  requests: number;
  successes: number;
  avgLatencyMs: number | null;
  lastRequestAt: string | null;
}

export interface ProviderKeySlotUsageRow {
  provider: string;
  connectionId: string;
  keySlot: string;
  requests: number;
  successfulRequests: number;
  totalTokens: number;
}

export interface SearchProviderStatRow {
  provider: string;
  requests: number;
  avg_latency_ms: number;
}

export interface SearchRecentRow {
  request_summary: string | null;
  provider: string;
  timestamp: string;
}

export interface SearchAggregateStats {
  total: number;
  today: number;
  errors: number;
  avg_duration: number | null;
  cached: number;
}

export interface SearchProviderCountRow {
  provider: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// /api/provider-metrics — aggregate per-provider stats
// ---------------------------------------------------------------------------

/**
 * Returns one row per provider with call-level aggregates plus last-status
 * subselects. Excludes rows where provider is NULL or '-', and excludes
 * providers with no live row in `provider_connections` — a deleted provider
 * connection must not keep surfacing as a ghost topology node forever from
 * its retained historical call_logs rows. See #10714.
 */
export function getProviderMetrics(): ProviderMetricRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
          c.provider,
          COUNT(*) as totalRequests,
          SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) as totalSuccesses,
          ROUND(AVG(duration)) as avgLatencyMs,
          MAX(timestamp) as lastRequestAt,
          MAX(
            CASE
              WHEN (status IS NOT NULL AND (status < 200 OR status >= 400))
                OR error_summary IS NOT NULL
              THEN timestamp
              ELSE NULL
            END
          ) as lastErrorAt,
          (
            SELECT c2.status
            FROM call_logs c2
            WHERE c2.provider = c.provider
            ORDER BY c2.timestamp DESC, c2.id DESC
            LIMIT 1
          ) as lastStatus,
          (
            SELECT c3.status
            FROM call_logs c3
            WHERE c3.provider = c.provider
              AND (
                (c3.status IS NOT NULL AND (c3.status < 200 OR c3.status >= 400))
                OR c3.error_summary IS NOT NULL
              )
            ORDER BY c3.timestamp DESC, c3.id DESC
            LIMIT 1
          ) as lastErrorStatus
        FROM call_logs c
        WHERE c.provider IS NOT NULL AND c.provider != '-'
          AND EXISTS (
            SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider
          )
        GROUP BY c.provider`
    )
    .all() as ProviderMetricRow[];
}

// ---------------------------------------------------------------------------
// /api/free-provider-rankings — windowed usage aggregate
// ---------------------------------------------------------------------------

/**
 * Per-provider usage over a time window: how much traffic a provider actually
 * served, and how much of it succeeded.
 *
 * Deliberately NOT `getProviderMetrics()` with a `since` parameter: that query
 * carries two correlated subqueries (`lastStatus`, `lastErrorStatus`) which a
 * ranking never displays, and they dominate its cost — `call_logs` is indexed
 * on `timestamp` alone, so each correlated pass rescans the whole window per
 * provider. Here a single bounded `GROUP BY` uses `idx_cl_timestamp` and stops
 * there. The rules are shared with its neighbour, not the query: same success
 * definition, same `#10714` guard against providers whose connections are gone.
 */
export function getProviderUsageSince(since: string): ProviderUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
          c.provider,
          COUNT(*) as requests,
          SUM(CASE WHEN c.status >= 200 AND c.status < 400 THEN 1 ELSE 0 END) as successes,
          ROUND(AVG(c.duration)) as avgLatencyMs,
          MAX(c.timestamp) as lastRequestAt
        FROM call_logs c
        WHERE c.provider IS NOT NULL AND c.provider != '-'
          AND c.timestamp >= @since
          AND EXISTS (
            SELECT 1 FROM provider_connections pc WHERE pc.provider = c.provider
          )
        GROUP BY c.provider`
    )
    .all({ since }) as ProviderUsageRow[];
}

/** Per-credential-slot usage for Mistral's primary and extra API keys. */
export function getMistralKeySlotUsage(since: string | null): ProviderKeySlotUsageRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT
          LOWER(provider) AS provider,
          connection_id AS connectionId,
          COALESCE(NULLIF(provider_key_slot, ''), 'unattributed') AS keySlot,
          COUNT(*) AS requests,
          SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS successfulRequests,
          COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS totalTokens
        FROM call_logs
        WHERE LOWER(provider) = 'mistral'
          AND connection_id IS NOT NULL AND connection_id != ''
          AND (@since IS NULL OR timestamp >= @since)
        GROUP BY LOWER(provider), connection_id, COALESCE(NULLIF(provider_key_slot, ''), 'unattributed')
        ORDER BY connection_id, keySlot`
    )
    .all({ since }) as ProviderKeySlotUsageRow[];
}

/**
 * Count persisted OpenRouter free-variant requests for one connection in the
 * current UTC day. This is the durable dashboard source of truth; the
 * dispatch-time free-window tracker remains useful for preflight/RPM gating,
 * but is intentionally in-memory and cannot survive a runtime restart.
 */
export function getOpenrouterFreeRequestsToday(connectionId: string): number {
  if (!connectionId) return 0;

  const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS requests
         FROM call_logs
        WHERE provider = 'openrouter'
          AND connection_id = ?
          AND timestamp >= ?
          AND (
            LOWER(COALESCE(model, '')) LIKE '%:free'
            OR LOWER(COALESCE(requested_model, '')) LIKE '%:free'
          )`
    )
    .get(connectionId, dayStart) as { requests?: number } | undefined;

  return Number.isFinite(Number(row?.requests)) ? Number(row?.requests) : 0;
}

// ---------------------------------------------------------------------------
// /api/search/stats — search provider aggregates + recent entries
// ---------------------------------------------------------------------------

/**
 * Per-provider request count and average latency for search requests.
 */
export function getSearchProviderStats(): SearchProviderStatRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
        SELECT provider, COUNT(*) as requests,
          CAST(AVG(duration) AS INTEGER) as avg_latency_ms
        FROM call_logs
        WHERE request_type = 'search'
        GROUP BY provider
      `
    )
    .all() as SearchProviderStatRow[];
}

/**
 * Most recent 10 search entries (request_summary + provider + timestamp).
 */
export function getRecentSearchLogs(): SearchRecentRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `
        SELECT request_summary, provider, timestamp
        FROM call_logs
        WHERE request_type = 'search'
        ORDER BY timestamp DESC
        LIMIT 10
      `
    )
    .all() as SearchRecentRow[];
}

// ---------------------------------------------------------------------------
// /api/v1/search/analytics — aggregated search analytics
// ---------------------------------------------------------------------------

/**
 * Single-pass scalar aggregations for all search entries since `todayIso`.
 * `todayIso` is the ISO-8601 UTC start-of-day string used for the "today" count.
 */
export function getSearchAggregateStats(todayIso: string): SearchAggregateStats {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END), 0) as today,
          COALESCE(SUM(CASE WHEN status >= 400 OR error_summary IS NOT NULL THEN 1 ELSE 0 END), 0) as errors,
          AVG(CASE WHEN duration > 0 THEN duration END) as avg_duration,
          COALESCE(SUM(CASE WHEN duration > 0 AND duration < 5 THEN 1 ELSE 0 END), 0) as cached
         FROM call_logs
         WHERE request_type = 'search'`
    )
    .get(todayIso) as SearchAggregateStats | undefined;
  return row ?? { total: 0, today: 0, errors: 0, avg_duration: null, cached: 0 };
}

/**
 * Per-provider request count for search entries, ordered by count descending.
 */
export function getSearchProviderCounts(): SearchProviderCountRow[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT provider, COUNT(*) as cnt
         FROM call_logs WHERE request_type = 'search'
         GROUP BY provider ORDER BY cnt DESC`
    )
    .all() as SearchProviderCountRow[];
}

// ---------------------------------------------------------------------------
// /api/usage/analytics — fallback-rate aggregates over call_logs
// ---------------------------------------------------------------------------

export interface FallbackStatsRow {
  total: number;
  with_requested: number;
  fallback_eligible: number;
  fallbacks: number;
}

/**
 * Scalar fallback-rate stats over `call_logs` for the usage analytics endpoint.
 *
 * @param whereClause - SQL WHERE clause (may be empty string) using the same
 *                      named params as the usage_history queries.
 * @param params      - Named params object (string values).
 */
export function getFallbackStats(
  whereClause: string,
  params: Record<string, string>
): FallbackStatsRow {
  const db = getDbInstance();
  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as total,
        SUM(CASE WHEN requested_model IS NOT NULL AND requested_model != '' AND (combo_name IS NULL OR combo_name = '') THEN 1 ELSE 0 END) as with_requested,
        SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
          THEN 1 ELSE 0 END
        ) as fallback_eligible,
        SUM(CASE
          WHEN (combo_name IS NULL OR combo_name = '')
           AND requested_model IS NOT NULL
           AND requested_model != ''
           AND model IS NOT NULL
           AND model != ''
           AND LOWER(CASE WHEN instr(requested_model, '/') > 0 THEN substr(requested_model, instr(requested_model, '/') + 1) ELSE requested_model END) != LOWER(model)
          THEN 1 ELSE 0 END
        ) as fallbacks
      FROM call_logs
      ${whereClause}
    `
    )
    .get(params) as FallbackStatsRow | undefined;
  return row ?? { total: 0, with_requested: 0, fallback_eligible: 0, fallbacks: 0 };
}

/**
 * Failure-family breakdown over `call_logs` for the usage analytics endpoint.
 * Failures are rows with status >= 400 or a non-empty error summary; successes
 * are excluded in SQL. Pre-migration rows and failures the classifier does not
 * recognize (null family) land in the explicit `unclassified` bucket.
 *
 * @param whereClause - SQL WHERE clause (may be empty string) using the same
 *                      named params as the usage_history queries.
 * @param params      - Named params object (string values).
 */
export function getErrorTypeBreakdown(
  whereClause: string,
  params: Record<string, string>
): Array<{ errorType: string; count: number }> {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `
      SELECT
        COALESCE(error_type, 'unclassified') AS errorType,
        COUNT(*) AS count
      FROM call_logs
      ${whereClause} ${whereClause ? "AND" : "WHERE"} (status >= 400 OR error_summary IS NOT NULL)
      GROUP BY 1
      ORDER BY count DESC, errorType ASC
      `
    )
    .all(params) as Array<{ errorType: string; count: number }>;
  return rows.map((row) => ({ errorType: String(row.errorType), count: Number(row.count) }));
}
