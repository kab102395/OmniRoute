import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { addProviderLimitsFreshness } from "@/lib/usage/providerLimitsCache";
import {
  getLastProviderLimitsAutoSyncTime,
  getProviderLimitsSyncIntervalMinutes,
  getSanitizedCachedProviderLimitsMap,
  syncAllProviderLimits,
} from "@/lib/usage/providerLimits";

/**
 * GET /api/usage/provider-limits
 * Returns cached Provider Limits data without triggering live refreshes.
 */
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const intervalMinutes = getProviderLimitsSyncIntervalMinutes();
    return NextResponse.json({
      caches: addProviderLimitsFreshness(
        await getSanitizedCachedProviderLimitsMap(),
        intervalMinutes * 60 * 1000
      ),
      intervalMinutes,
      lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    });
  } catch (error) {
    console.error("[API] GET /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to fetch cached provider limits" }, { status: 500 });
  }
}

/**
 * POST /api/usage/provider-limits
 * Manually refresh all supported Provider Limits entries.
 */
export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const result = await syncAllProviderLimits({ source: "manual" });
    const intervalMinutes = getProviderLimitsSyncIntervalMinutes();
    const caches = addProviderLimitsFreshness(
      await getSanitizedCachedProviderLimitsMap(),
      intervalMinutes * 60 * 1000
    );
    return NextResponse.json({
      ...result,
      caches,
      intervalMinutes,
      lastAutoSyncAt: await getLastProviderLimitsAutoSyncTime(),
    });
  } catch (error) {
    console.error("[API] POST /api/usage/provider-limits error:", error);
    return NextResponse.json({ error: "Failed to refresh provider limits" }, { status: 500 });
  }
}
