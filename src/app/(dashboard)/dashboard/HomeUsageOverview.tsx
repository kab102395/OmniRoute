"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { NOAUTH_PROVIDERS } from "@/shared/constants/providers/noauth";

type AnalyticsProviderRow = {
  provider?: unknown;
  requests?: unknown;
  totalTokens?: unknown;
  successfulRequests?: unknown;
};

type ProviderConnection = {
  id?: string;
  provider?: string;
  name?: string;
  displayName?: string;
  email?: string;
  isActive?: boolean;
  providerSpecificData?: {
    extraApiKeys?: unknown;
  };
  keyRotation?: {
    totalSelections?: unknown;
    byKeyId?: Record<string, unknown>;
    lastKeyId?: unknown;
  };
};

type QuotaRow = {
  used?: unknown;
  total?: unknown;
  remaining?: unknown;
  unit?: unknown;
  displayName?: unknown;
  quotaSource?: unknown;
  currency?: unknown;
};

type ProviderLimitCache = {
  quotas?: Record<string, QuotaRow> | null;
  message?: string | null;
};

type HomeProviderUsageRow = {
  provider: string;
  label: string;
  requests: number;
  totalTokens: number;
  successfulRequests: number;
  quota: QuotaRow | null;
  quotaKey: string | null;
  creditQuota: QuotaRow | null;
};

type UsageResponse = {
  byProvider?: AnalyticsProviderRow[];
  byMistralKeySlot?: Array<{
    provider?: unknown;
    connectionId?: unknown;
    keySlot?: unknown;
    requests?: unknown;
    successfulRequests?: unknown;
    totalTokens?: unknown;
  }>;
};

const FREE_ROUTE_IDS = [
  "freebuff",
  "openrouter",
  "opencode",
  "duckduckgo-web",
  "cloudflare-playground",
  "chipotle",
  "veoaifree-web",
  "uncloseai",
  "aihorde",
  "pollinations",
] as const;

const FREE_ROUTE_NOTES: Record<string, string> = {
  freebuff: "Account Freebucks balance",
  openrouter: "Free-model daily meter + credit balance",
  opencode: "No key; public free endpoint",
  "duckduckgo-web": "No key; anonymous access",
  "cloudflare-playground": "No key; IP-limited browser route",
  chipotle: "No key; anonymous support-chat route",
  "veoaifree-web": "No key; 6 video requests/hour per IP",
  uncloseai: "No key; public OpenAI-compatible route",
  aihorde: "No key; volunteer queue",
  pollinations: "Keyless best-effort free models",
};

const numberValue = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function formatHomeUsageNumber(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

function providerIdForRow(value: unknown, connections: ProviderConnection[]): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "unknown";
  const normalizedRaw = raw.replace(/[\s_-]+ai$/, "");
  const direct = connections.find((connection) => {
    const connectionProvider = connection.provider?.toLowerCase() || "";
    return connectionProvider === raw || connectionProvider === normalizedRaw;
  });
  if (direct?.provider) return direct.provider.toLowerCase();

  const known = Object.entries(AI_PROVIDERS).find(([id, definition]) => {
    const name = typeof definition?.name === "string" ? definition.name.toLowerCase() : "";
    const alias = typeof definition?.alias === "string" ? definition.alias.toLowerCase() : "";
    return (
      id === raw || id === normalizedRaw || name === raw || name === normalizedRaw || alias === raw
    );
  });
  return known?.[0] || raw.replace(/\s+/g, "-");
}

function providerLabel(provider: string, connections: ProviderConnection[]): string {
  const definition = AI_PROVIDERS[provider];
  const label = typeof definition?.name === "string" ? definition.name : provider;
  if (provider !== "mistral") return label;

  const keyCount = connections
    .filter((connection) => connection.isActive !== false && connection.provider === provider)
    .reduce((count, connection) => {
      const extraKeys = Array.isArray(connection.providerSpecificData?.extraApiKeys)
        ? connection.providerSpecificData.extraApiKeys.filter(
            (key) => typeof key === "string" && key.trim().length > 0
          ).length
        : 0;
      return count + 1 + extraKeys;
    }, 0);

  return keyCount > 1 ? `${label} (${keyCount} keys)` : label;
}

function quotasForProvider(
  provider: string,
  caches: Record<string, ProviderLimitCache>,
  connections: ProviderConnection[]
): { quota: QuotaRow | null; quotaKey: string | null; creditQuota: QuotaRow | null } {
  const entries = connections
    .filter((connection) => connection.isActive !== false && connection.provider === provider)
    .map((connection) => (connection.id ? caches[connection.id] : undefined))
    .filter((entry): entry is ProviderLimitCache => !!entry);
  for (const entry of entries) {
    const quotas = entry.quotas || {};
    if (provider === "openrouter") {
      if (quotas.free_daily || quotas.credits) {
        return {
          quota: quotas.free_daily || null,
          quotaKey: quotas.free_daily ? "free_daily" : null,
          creditQuota: quotas.credits || null,
        };
      }
    }
    const preferredKey = quotas.monthly ? "monthly" : quotas.free_daily ? "free_daily" : "credits";
    const preferred = quotas[preferredKey];
    if (preferred) return { quota: preferred, quotaKey: preferredKey, creditQuota: null };
  }
  return { quota: null, quotaKey: null, creditQuota: null };
}

function rotationSummary(provider: string, connections: ProviderConnection[]): string | null {
  if (provider !== "mistral") return null;
  const connection = connections.find(
    (candidate) => candidate.isActive !== false && candidate.provider === provider
  );
  const stats = connection?.keyRotation;
  if (!stats || !stats.byKeyId) return null;
  const slots = Object.entries(stats.byKeyId)
    .filter(([, count]) => Number(count) > 0)
    .map(([keyId, count]) => `${keyId}: ${Number(count)}`);
  return slots.length > 0 ? `Key rotation · ${slots.join(" · ")}` : null;
}

export function buildHomeProviderUsageRows(
  analyticsRows: AnalyticsProviderRow[],
  caches: Record<string, ProviderLimitCache>,
  connections: ProviderConnection[]
): HomeProviderUsageRow[] {
  const grouped = new Map<string, HomeProviderUsageRow>();
  for (const row of analyticsRows) {
    const provider = providerIdForRow(row.provider, connections);
    const current = grouped.get(provider) || {
      provider,
      label: providerLabel(provider, connections),
      requests: 0,
      totalTokens: 0,
      successfulRequests: 0,
      quota: null,
      quotaKey: null,
      creditQuota: null,
    };
    current.requests += numberValue(row.requests);
    current.totalTokens += numberValue(row.totalTokens);
    current.successfulRequests += numberValue(row.successfulRequests);
    grouped.set(provider, current);
  }

  for (const connection of connections) {
    if (connection.isActive === false || !connection.provider) continue;
    const provider = connection.provider.toLowerCase();
    if (!grouped.has(provider)) {
      grouped.set(provider, {
        provider,
        label: providerLabel(provider, connections),
        requests: 0,
        totalTokens: 0,
        successfulRequests: 0,
        quota: null,
        quotaKey: null,
        creditQuota: null,
      });
    }
  }

  return Array.from(grouped.values())
    .map((row) => ({ ...row, ...quotasForProvider(row.provider, caches, connections) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
}

function quotaTotal(quota: QuotaRow | null): number {
  return numberValue(quota?.total);
}

function quotaRemaining(quota: QuotaRow | null): number {
  if (!quota) return 0;
  if (quota.remaining !== undefined) return numberValue(quota.remaining);
  return Math.max(0, quotaTotal(quota) - numberValue(quota.used));
}

function freeRouteLabel(provider: string): string {
  if (provider === "freebuff") return "Freebuff";
  if (provider === "openrouter") return "OpenRouter free pool";
  const noAuth = NOAUTH_PROVIDERS[provider as keyof typeof NOAUTH_PROVIDERS];
  return typeof noAuth?.name === "string" ? noAuth.name : provider;
}

export default function HomeUsageOverview() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [caches, setCaches] = useState<Record<string, ProviderLimitCache>>({});
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async (showLoading = false) => {
      if (showLoading) setLoading(true);
      try {
        const [usageResponse, limitsResponse, providerResponse] = await Promise.all([
          fetch("/api/usage/analytics?range=30d", { cache: "no-store" }).then((response) =>
            response.ok ? (response.json() as Promise<UsageResponse>) : null
          ),
          fetch("/api/usage/provider-limits", { cache: "no-store" }).then((response) =>
            response.ok
              ? (response.json() as Promise<{ caches?: Record<string, ProviderLimitCache> }>)
              : null
          ),
          fetch("/api/providers", { cache: "no-store" }).then((response) =>
            response.ok
              ? (response.json() as Promise<{ connections?: ProviderConnection[] }>)
              : null
          ),
        ]);
        if (cancelled) return;
        setUsage(usageResponse);
        setCaches(limitsResponse?.caches || {});
        setConnections(providerResponse?.connections || []);
      } catch {
        // Keep the last successful snapshot visible during a transient refresh failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    void load(true);
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const rows = useMemo(
    () => buildHomeProviderUsageRows(usage?.byProvider || [], caches, connections),
    [usage?.byProvider, caches, connections]
  );
  const totals = useMemo(
    () =>
      rows.reduce(
        (result, row) => ({
          requests: result.requests + row.requests,
          tokens: result.tokens + row.totalTokens,
        }),
        { requests: 0, tokens: 0 }
      ),
    [rows]
  );
  const freeRoutes = useMemo(
    () =>
      FREE_ROUTE_IDS.map((provider) => {
        const row = rows.find((candidate) => candidate.provider === provider);
        const quota = row?.quota || null;
        const remaining = quotaRemaining(quota);
        let status = "Available";
        if (provider === "freebuff") {
          status = quota ? `${formatHomeUsageNumber(remaining)} Freebucks left` : "Connect account";
        } else if (provider === "openrouter") {
          status = quota
            ? `${formatHomeUsageNumber(remaining)} free requests left`
            : "Connect account";
        } else if (row && row.requests > 0) {
          status = `${formatHomeUsageNumber(row.requests)} requests routed`;
        }
        return {
          provider,
          label: freeRouteLabel(provider),
          note: FREE_ROUTE_NOTES[provider],
          status,
        };
      }),
    [rows]
  );
  const mistralKeyUsage = useMemo(() => {
    const accountLabels = new Map(
      connections
        .filter((connection) => connection.provider === "mistral" && connection.id)
        .map((connection, index) => [
          connection.id as string,
          connection.displayName ||
            connection.name ||
            connection.email ||
            `Mistral account ${index + 1}`,
        ])
    );
    return (usage?.byMistralKeySlot || [])
      .filter((entry) => entry.provider === "mistral")
      .map((entry) => {
        const slot = typeof entry.keySlot === "string" ? entry.keySlot : "unattributed";
        const keyName =
          slot === "primary"
            ? "Primary key"
            : /^extra_\d+$/.test(slot)
              ? `Additional key ${Number(slot.slice(6)) + 1}`
              : "Older requests (key not recorded)";
        const connectionId = typeof entry.connectionId === "string" ? entry.connectionId : "";
        return {
          id: `${connectionId}:${slot}`,
          label: accountLabels.get(connectionId) || "Mistral account",
          keyName,
          requests: numberValue(entry.requests),
          successfulRequests: numberValue(entry.successfulRequests),
          totalTokens: numberValue(entry.totalTokens),
        };
      });
  }, [usage?.byMistralKeySlot, connections]);

  if (loading) return <Card className="min-h-[220px] animate-pulse" />;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">monitoring</span>
              <h2 className="text-lg font-semibold">OmniRoute usage pulse</h2>
            </div>
            <p className="text-sm text-text-muted mt-1">
              Last 30 days across every provider routed through OmniRoute
            </p>
          </div>
          <Link
            href="/dashboard/usage"
            prefetch={false}
            className="text-xs text-primary hover:underline"
          >
            View full analytics →
          </Link>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div className="rounded-xl border border-border bg-bg-subtle p-3">
            <p className="text-[11px] uppercase tracking-wide text-text-muted">Tokens routed</p>
            <p className="text-xl font-bold mt-1">{formatHomeUsageNumber(totals.tokens)}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-subtle p-3">
            <p className="text-[11px] uppercase tracking-wide text-text-muted">Requests</p>
            <p className="text-xl font-bold mt-1">{formatHomeUsageNumber(totals.requests)}</p>
          </div>
          <div className="rounded-xl border border-border bg-bg-subtle p-3 col-span-2 md:col-span-1">
            <p className="text-[11px] uppercase tracking-wide text-text-muted">Providers active</p>
            <p className="text-xl font-bold mt-1">{rows.length}</p>
          </div>
        </div>

        <details className="rounded-xl border border-border bg-bg-subtle p-3">
          <summary className="cursor-pointer text-sm font-semibold">
            Free routes at a glance{" "}
            <span className="text-xs font-normal text-text-muted">
              · {freeRoutes.length} routes
            </span>
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-3">
            {freeRoutes.map((route) => (
              <div
                key={route.provider}
                className="rounded-lg border border-border/70 bg-surface px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ProviderIcon providerId={route.provider} size={20} type="color" />
                  <span className="text-xs font-semibold truncate">{route.label}</span>
                </div>
                <p className="text-xs font-medium text-green-500 mt-2">{route.status}</p>
                <p className="text-[10px] text-text-muted mt-1 truncate" title={route.note}>
                  {route.note}
                </p>
              </div>
            ))}
          </div>
          <Link
            href="/dashboard/providers"
            prefetch={false}
            className="mt-3 inline-block text-xs text-primary hover:underline"
          >
            Manage routes →
          </Link>
        </details>

        {rows.length === 0 ? (
          <p className="text-sm text-text-muted rounded-xl border border-dashed border-border p-5">
            Provider usage will appear here after your first routed request.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.map((row) => {
              const isOpenRouter = row.provider === "openrouter";
              const isFreebuff = row.provider === "freebuff";
              const total = quotaTotal(row.quota);
              const remaining = quotaRemaining(row.quota);
              const used = numberValue(row.quota?.used);
              const percentage = total > 0 ? Math.min(100, (used / total) * 100) : 0;
              const displayRequests = isOpenRouter && row.quota ? used : row.requests;
              const creditBalance = numberValue(row.creditQuota?.remaining);
              return (
                <div key={row.provider} className="rounded-xl border border-border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderIcon providerId={row.provider} size={26} type="color" />
                      <span className="font-semibold truncate">{row.label}</span>
                    </div>
                    <span className="text-xs text-text-muted whitespace-nowrap">
                      {formatHomeUsageNumber(displayRequests)} requests
                    </span>
                  </div>
                  {rotationSummary(row.provider, connections) && (
                    <p className="text-[11px] text-text-muted mt-2">
                      {rotationSummary(row.provider, connections)}
                    </p>
                  )}
                  {row.provider === "mistral" && (
                    <div className="mt-3 rounded-lg border border-border/70 bg-bg-subtle p-3">
                      <p className="text-xs font-semibold mb-2">
                        Usage by Mistral API key · last 30 days
                      </p>
                      {mistralKeyUsage.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {mistralKeyUsage.map((keyUsage) => (
                            <div key={keyUsage.id} className="rounded-md bg-surface px-3 py-2">
                              <p className="text-xs font-medium truncate">
                                {keyUsage.label} · {keyUsage.keyName}
                              </p>
                              <p className="mt-1 text-sm font-semibold">
                                {formatHomeUsageNumber(keyUsage.totalTokens)} tokens
                                <span className="ml-2 text-xs font-normal text-text-muted">
                                  {formatHomeUsageNumber(keyUsage.requests)} requests
                                </span>
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[11px] text-text-muted">
                          Per-key usage will appear after requests are logged with a key slot.
                        </p>
                      )}
                      <p className="text-[10px] text-text-muted mt-2">
                        Based on recorded request logs; historical requests without key-slot
                        metadata are listed separately.
                      </p>
                    </div>
                  )}
                  <div className="flex items-end justify-between mt-4">
                    <div>
                      <p className="text-2xl font-bold">{formatHomeUsageNumber(row.totalTokens)}</p>
                      <p className="text-xs text-text-muted">tokens routed</p>
                    </div>
                    {isOpenRouter && row.quota && total > 0 ? (
                      <div className="text-right">
                        <p className="text-sm font-semibold text-green-500">
                          {formatHomeUsageNumber(remaining)} requests left
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {formatHomeUsageNumber(used)} / {formatHomeUsageNumber(total)} daily free
                          tier
                        </p>
                      </div>
                    ) : isFreebuff && row.quota && total > 0 ? (
                      <div className="text-right">
                        <p className="text-sm font-semibold text-green-500">
                          {formatHomeUsageNumber(remaining)} Freebucks left
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {formatHomeUsageNumber(used)} / {formatHomeUsageNumber(total)} daily
                        </p>
                      </div>
                    ) : row.quota && total > 0 ? (
                      <div className="text-right">
                        <p className="text-sm font-semibold text-green-500">
                          {formatHomeUsageNumber(remaining)} left
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {formatHomeUsageNumber(used)} / {formatHomeUsageNumber(total)} allowance
                        </p>
                      </div>
                    ) : (
                      <span className="text-[11px] text-text-muted">Allowance not reported</span>
                    )}
                  </div>
                  {isOpenRouter && row.creditQuota && (
                    <div className="mt-3 flex items-center justify-between rounded-lg bg-green-500/10 px-3 py-2">
                      <span className="text-xs text-text-muted">OpenRouter credit balance</span>
                      <span className="text-sm font-semibold text-green-500">
                        ${creditBalance.toFixed(2)}
                      </span>
                    </div>
                  )}
                  {row.quota && total > 0 && (
                    <div className="mt-3 h-2 rounded-full bg-bg-subtle overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-primary to-cyan-400 transition-all"
                        style={{ width: `${percentage}%` }}
                        aria-label={`${percentage.toFixed(1)} percent of allowance used`}
                      />
                    </div>
                  )}
                  <p className="text-[11px] text-text-muted mt-3">
                    {isOpenRouter
                      ? "Requests are the OpenRouter free-tier meter; tokens are shown as secondary usage."
                      : isFreebuff
                        ? "Freebucks balance and reset are read from Freebuff; tokens are OmniRoute-local usage."
                        : row.quota
                          ? "Allowance data is shown from the latest provider sync."
                          : "Usage is tracked locally; this provider does not expose a known allowance to OmniRoute."}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
