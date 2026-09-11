"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS } from "@/shared/constants/providers";

type AnalyticsProviderRow = {
  provider?: unknown;
  requests?: unknown;
  totalTokens?: unknown;
  successfulRequests?: unknown;
};

type ProviderConnection = {
  id?: string;
  provider?: string;
  isActive?: boolean;
};

type QuotaRow = {
  used?: unknown;
  total?: unknown;
  remaining?: unknown;
  unit?: unknown;
  displayName?: unknown;
  quotaSource?: unknown;
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
};

type UsageResponse = {
  byProvider?: AnalyticsProviderRow[];
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

function providerLabel(provider: string): string {
  const definition = AI_PROVIDERS[provider];
  return typeof definition?.name === "string" ? definition.name : provider;
}

function quotaForProvider(
  provider: string,
  caches: Record<string, ProviderLimitCache>,
  connections: ProviderConnection[]
): QuotaRow | null {
  const entries = connections
    .filter((connection) => connection.isActive !== false && connection.provider === provider)
    .map((connection) => (connection.id ? caches[connection.id] : undefined))
    .filter((entry): entry is ProviderLimitCache => !!entry);
  for (const entry of entries) {
    const quotas = entry.quotas || {};
    const preferred = quotas.monthly || quotas.free_daily || quotas.credits;
    if (preferred) return preferred;
  }
  return null;
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
      label: providerLabel(provider),
      requests: 0,
      totalTokens: 0,
      successfulRequests: 0,
      quota: null,
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
        label: providerLabel(provider),
        requests: 0,
        totalTokens: 0,
        successfulRequests: 0,
        quota: null,
      });
    }
  }

  return Array.from(grouped.values())
    .map((row) => ({ ...row, quota: quotaForProvider(row.provider, caches, connections) }))
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

export default function HomeUsageOverview() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [caches, setCaches] = useState<Record<string, ProviderLimitCache>>({});
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/usage/analytics?range=30d").then((response) =>
        response.ok ? (response.json() as Promise<UsageResponse>) : null
      ),
      fetch("/api/usage/provider-limits").then((response) =>
        response.ok
          ? (response.json() as Promise<{ caches?: Record<string, ProviderLimitCache> }>)
          : null
      ),
      fetch("/api/providers").then((response) =>
        response.ok ? (response.json() as Promise<{ connections?: ProviderConnection[] }>) : null
      ),
    ])
      .then(([usageResponse, limitsResponse, providerResponse]) => {
        if (cancelled) return;
        setUsage(usageResponse);
        setCaches(limitsResponse?.caches || {});
        setConnections(providerResponse?.connections || []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
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

        {rows.length === 0 ? (
          <p className="text-sm text-text-muted rounded-xl border border-dashed border-border p-5">
            Provider usage will appear here after your first routed request.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.map((row) => {
              const total = quotaTotal(row.quota);
              const remaining = quotaRemaining(row.quota);
              const used = numberValue(row.quota?.used);
              const percentage = total > 0 ? Math.min(100, (used / total) * 100) : 0;
              return (
                <div key={row.provider} className="rounded-xl border border-border p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderIcon providerId={row.provider} size={26} type="color" />
                      <span className="font-semibold truncate">{row.label}</span>
                    </div>
                    <span className="text-xs text-text-muted whitespace-nowrap">
                      {formatHomeUsageNumber(row.requests)} requests
                    </span>
                  </div>
                  <div className="flex items-end justify-between mt-4">
                    <div>
                      <p className="text-2xl font-bold">{formatHomeUsageNumber(row.totalTokens)}</p>
                      <p className="text-xs text-text-muted">tokens routed</p>
                    </div>
                    {row.quota && total > 0 ? (
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
                    {row.quota
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
