import {
  applyOpenRouterGenerationReceipts,
  type CostAccountingFacts,
} from "@/lib/usage/costAccounting";
import {
  fetchOpenRouterGenerationReceipts,
  type OpenRouterGenerationReceipt,
} from "@/lib/usage/openrouterGeneration";
import { updateCallLogAccounting, updateRequestUsageAccounting } from "@/lib/usageDb";

export type OpenRouterReceiptEnrichmentArgs = {
  generationIds: readonly string[];
  apiKey: string;
  usageRequestId: string;
  callLogId: string;
  accounting: CostAccountingFacts;
  usageSaved?: Promise<unknown>;
};

type Dependencies = {
  fetchReceipts: typeof fetchOpenRouterGenerationReceipts;
  updateUsage: typeof updateRequestUsageAccounting;
  updateCallLog: typeof updateCallLogAccounting;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
  fetchReceipts: fetchOpenRouterGenerationReceipts,
  updateUsage: updateRequestUsageAccounting,
  updateCallLog: updateCallLogAccounting,
};

/**
 * Enrich an already completed OpenRouter request without holding up its response.
 * The callback is intentionally best-effort: OpenRouter may not have indexed a
 * generation yet. Unavailable metadata records the unresolved generation IDs
 * while preserving the original cost classification.
 */
export function scheduleOpenRouterReceiptEnrichment(
  args: OpenRouterReceiptEnrichmentArgs,
  callLogSaved: Promise<void>,
  dependencies: Dependencies = DEFAULT_DEPENDENCIES
): void {
  if (args.generationIds.length === 0 || !args.apiKey || !args.usageRequestId || !args.callLogId) {
    return;
  }

  setImmediate(() => {
    void (async () => {
      const receipts: OpenRouterGenerationReceipt[] = await dependencies.fetchReceipts(
        args.generationIds,
        args.apiKey
      );

      const enriched = applyOpenRouterGenerationReceipts(
        args.accounting,
        args.generationIds,
        receipts
      );
      await Promise.all([callLogSaved, args.usageSaved]);
      await dependencies.updateUsage(args.usageRequestId, enriched);
      dependencies.updateCallLog(args.callLogId, enriched);
    })().catch(() => {
      // Metadata enrichment is diagnostic and cannot change request success.
    });
  });
}
