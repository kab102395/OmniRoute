/** Provider-reported execution metadata returned by OpenRouter for one generation. */
export interface OpenRouterGenerationReceipt {
  id: string;
  source: "openrouter.generation_api";
  retrievedAt: string;
  model: string | null;
  providerName: string | null;
  upstreamId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalCostUsd: number | null;
  upstreamInferenceCostUsd: number | null;
  isByok: boolean | null;
}

const GENERATION_API_URL = "https://openrouter.ai/api/v1/generation";
const REQUEST_TIMEOUT_MS = 3_000;
const GENERATION_INDEX_RETRY_DELAY_MS = 1_000;
const MAX_CONCURRENT_LOOKUPS = 4;
let activeGenerationLookups = 0;
type Waiter = (delayMs: number) => Promise<void>;

const wait: Waiter = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 512): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function isOpenRouterGenerationId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^gen-[0-9A-Za-z-]+$/.test(value);
}

/**
 * Fetch a single completed generation receipt. This is a best-effort metadata
 * read after inference; it retries one briefly unindexed generation and is
 * bounded so it cannot hold up a model response. The generation id is verified
 * against the response to avoid attaching a mismatched receipt.
 */
export async function fetchOpenRouterGenerationReceipt(
  generationId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  waiter: Waiter = wait
): Promise<OpenRouterGenerationReceipt | null> {
  if (!isOpenRouterGenerationId(generationId) || !apiKey.trim()) {
    return null;
  }
  if (activeGenerationLookups >= MAX_CONCURRENT_LOOKUPS) return null;
  activeGenerationLookups += 1;

  const url = new URL(GENERATION_API_URL);
  url.searchParams.set("id", generationId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      response = await fetcher(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (response.status !== 404 || attempt === 1) break;
      await waiter(GENERATION_INDEX_RETRY_DELAY_MS);
    }
    if (!response?.ok) return null;

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !isRecord(payload.data) || payload.data.id !== generationId) {
      return null;
    }
    const data = payload.data;
    return {
      id: generationId,
      source: "openrouter.generation_api",
      retrievedAt: new Date().toISOString(),
      model: safeString(data.model),
      providerName: safeString(data.provider_name),
      upstreamId: safeString(data.upstream_id),
      promptTokens: nonNegativeInteger(data.tokens_prompt),
      completionTokens: nonNegativeInteger(data.tokens_completion),
      totalCostUsd: nonNegativeFinite(data.total_cost),
      upstreamInferenceCostUsd: nonNegativeFinite(data.upstream_inference_cost),
      isByok: typeof data.is_byok === "boolean" ? data.is_byok : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    activeGenerationLookups -= 1;
  }
}

/** Resolve deduplicated generation ids while keeping metadata reads bounded. */
export async function fetchOpenRouterGenerationReceipts(
  generationIds: readonly string[],
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<OpenRouterGenerationReceipt[]> {
  const ids = [...new Set(generationIds.filter((id) => typeof id === "string" && id.trim()))].slice(
    -8
  );
  const receipts: OpenRouterGenerationReceipt[] = [];
  for (let index = 0; index < ids.length; index += MAX_CONCURRENT_LOOKUPS) {
    const batch = await Promise.all(
      ids
        .slice(index, index + MAX_CONCURRENT_LOOKUPS)
        .map((id) => fetchOpenRouterGenerationReceipt(id, apiKey, fetcher))
    );
    receipts.push(
      ...batch.filter((receipt): receipt is OpenRouterGenerationReceipt => receipt !== null)
    );
  }
  return receipts;
}
