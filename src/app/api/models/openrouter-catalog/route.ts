/**
 * GET /api/models/openrouter-catalog
 * Feature 09 — Retorna catálogo OpenRouter com cache persistente.
 *
 * Query params:
 *   ?refresh=true  — Force-refresh, ignores TTL
 */

import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import {
  getOpenRouterCatalog,
  isOpenRouterFreeRoute,
  isOpenRouterZeroPriceRoute,
  refreshOpenRouterCatalog,
} from "@/lib/catalog/openrouterCatalog";
import { getSettings } from "@/lib/db/settings";

export async function GET(req: NextRequest) {
  // Require authentication (dashboard/API key)
  if (!(await isAuthenticated(req))) {
    return NextResponse.json(
      { error: { message: "Authentication required", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  // #6328 (follow-up to #6495): REMOVE — not just hide — paid models from the
  // OpenRouter catalog echo when hidePaidModels is on. Fail open on settings read.
  let hidePaid = false;
  try {
    const settings = await getSettings();
    hidePaid = settings?.hidePaidModels === true;
  } catch {}
  const applyFilter = <T extends { id?: string }>(data: T[], verified: boolean): T[] => {
    if (hidePaid && !verified) return [];
    const currentFreeRouteIds = new Set(
      verified
        ? data
            .filter(
              (model) =>
                typeof model.id === "string" &&
                (isOpenRouterFreeRoute(model.id) ||
                  isOpenRouterZeroPriceRoute(
                    model as {
                      pricing?: {
                        prompt?: unknown;
                        completion?: unknown;
                        image?: unknown;
                        request?: unknown;
                      };
                    }
                  ))
            )
            .map((model) => model.id as string)
        : []
    );
    const classified = verified
      ? data.map((model) => ({
          ...model,
          ...(typeof model.id === "string" ? { isFree: currentFreeRouteIds.has(model.id) } : {}),
        }))
      : data;
    return hidePaid
      ? classified.filter(
          (model) => typeof model.id === "string" && currentFreeRouteIds.has(model.id)
        )
      : classified;
  };

  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";

  if (forceRefresh) {
    const result = await refreshOpenRouterCatalog();
    const data = applyFilter(result.data, result.ok);
    return NextResponse.json({
      object: "list",
      data,
      meta: {
        source: result.ok ? "fresh" : "error",
        count: data.length,
        error: result.error ?? undefined,
      },
    });
  }

  const result = await getOpenRouterCatalog();
  const data = applyFilter(result.data, !result.stale);
  return NextResponse.json({
    object: "list",
    data,
    meta: {
      source: result.fromCache ? (result.stale ? "stale-cache" : "cache") : "fresh",
      cachedAt: result.cachedAt ?? undefined,
      stale: result.stale,
      count: data.length,
    },
  });
}
