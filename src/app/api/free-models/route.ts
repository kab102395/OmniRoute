import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { FREE_MODEL_BUDGETS } from "@omniroute/open-sse/config/freeModelCatalog";
import { getOpenRouterCatalog } from "@/lib/catalog/openrouterCatalog";
import { discoverOpenRouterFreeModels } from "@/lib/catalog/openrouterFreeModels";

// GET /api/free-models - List free model budgets for plugin enrichment
export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const models = FREE_MODEL_BUDGETS.map((m) => ({
      provider: m.provider,
      modelId: m.modelId,
      displayName: m.displayName,
      monthlyTokens: m.monthlyTokens,
      creditTokens: m.creditTokens,
      freeType: m.freeType,
      poolKey: m.poolKey,
      tos: m.tos,
    }));

    const includeLive = new URL(request.url).searchParams.get("includeLive") === "true";
    if (includeLive) {
      const catalog = await getOpenRouterCatalog();
      const staticKeys = new Set(models.map((m) => `${m.provider}:${m.modelId}`));
      const discovered = discoverOpenRouterFreeModels(
        catalog.data,
        catalog.cachedAt ?? new Date().toISOString()
      )
        .filter((m) => !staticKeys.has(`${m.provider}:${m.modelId}`))
        .map((m) => ({ ...m, live: true, stale: catalog.stale }));

      return NextResponse.json({
        models: [...models, ...discovered],
        meta: {
          includeLive: true,
          liveSource: "openrouter",
          liveCount: discovered.length,
          stale: catalog.stale,
          cachedAt: catalog.cachedAt,
        },
      });
    }

    return NextResponse.json({ models });
  } catch (error) {
    console.error("Error fetching free models:", error);
    return NextResponse.json({ models: [] });
  }
}
