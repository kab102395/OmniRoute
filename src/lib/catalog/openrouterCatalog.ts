/**
 * openrouterCatalog.ts — Feature 09
 * Catálogo OpenRouter com cache persistente em arquivo JSON local.
 *
 * - TTL configurável via env OPENROUTER_CATALOG_TTL_MS (default: 15m)
 * - Fallback stale-if-error: retorna último snapshot válido se fetch falhar
 * - Atualização oportunista em background (não bloqueia o caller)
 */

import fs from "fs";
import path from "path";
import { invalidateModelCatalogCache } from "@/lib/db/readCache";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes: free routes rotate more often than pricing catalogs
const FETCH_FAILURE_RETRY_MS = 60 * 1000;

function getTTL(): number {
  const env = process.env.OPENROUTER_CATALOG_TTL_MS;
  if (!env) return DEFAULT_TTL_MS;
  const parsed = Number.parseInt(env, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function getCacheFilePath(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  const cacheDir = path.join(dataDir, "cache");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, "openrouter-catalog.json");
}

export interface OpenRouterCatalogEntry {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: OpenRouterPricing;
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    instruct_type?: string;
  };
  supported_parameters?: string[];
  created?: number;
}

/** OpenRouter's model API pricing dimensions, including route-level overrides. */
export interface OpenRouterPricing {
  prompt?: unknown;
  completion?: unknown;
  image?: unknown;
  image_output?: unknown;
  image_token?: unknown;
  request?: unknown;
  audio?: unknown;
  audio_output?: unknown;
  input_audio_cache?: unknown;
  input_cache_read?: unknown;
  input_cache_write?: unknown;
  input_cache_write_1h?: unknown;
  internal_reasoning?: unknown;
  web_search?: unknown;
  discount?: unknown;
  overrides?: unknown;
}

/** OpenRouter expresses its catalog-level free offering as an exact `:free` route variant. */
export function isOpenRouterFreeRoute(modelId: string): boolean {
  return /^[^\s]+:free$/.test(modelId);
}

/** Explicit OpenRouter zero-rate evidence for this exact route, across reported billable fields. */
export function isOpenRouterZeroPriceRoute(model: { pricing?: OpenRouterPricing }): boolean {
  const isNumericZero = (value: unknown) =>
    (typeof value === "number" && value === 0) ||
    (typeof value === "string" && /^\+?0(?:\.0+)?$/.test(value));
  const pricing = model.pricing;
  const billableRateKeys = [
    "prompt",
    "completion",
    "image",
    "image_output",
    "image_token",
    "request",
    "audio",
    "audio_output",
    "input_audio_cache",
    "input_cache_read",
    "input_cache_write",
    "input_cache_write_1h",
    "internal_reasoning",
    "web_search",
  ] as const;
  const reportedRatesAreZero = (rates: Record<string, unknown>) =>
    billableRateKeys.every((key) => rates[key] === undefined || isNumericZero(rates[key]));
  const overrides = pricing?.overrides;
  const overridesAreZero =
    overrides === undefined ||
    (Array.isArray(overrides) &&
      overrides.every(
        (override) =>
          override !== null &&
          typeof override === "object" &&
          !Array.isArray(override) &&
          reportedRatesAreZero(override as Record<string, unknown>)
      ));
  return (
    pricing !== undefined &&
    isNumericZero(pricing.prompt) &&
    isNumericZero(pricing.completion) &&
    reportedRatesAreZero(pricing as Record<string, unknown>) &&
    overridesAreZero
  );
}

export type CurrentOpenRouterFreeRoute = {
  /** Omitted when the live catalog did not report `supported_parameters`. */
  supportsTools?: boolean;
};

/** Exact OpenRouter free routes and reported capability facts, or null when unverified. */
export async function getCurrentOpenRouterFreeRouteMetadata(options?: {
  requireTools?: boolean;
}): Promise<Map<string, CurrentOpenRouterFreeRoute> | null> {
  const catalog = await getOpenRouterCatalog();
  if (catalog.stale) return null;
  const routes = new Map<string, CurrentOpenRouterFreeRoute>();
  for (const entry of catalog.data) {
    const free = isOpenRouterFreeRoute(entry.id) || isOpenRouterZeroPriceRoute(entry);
    if (!free) continue;
    const supportsTools = Array.isArray(entry.supported_parameters)
      ? entry.supported_parameters.includes("tools")
      : undefined;
    if (options?.requireTools === true && supportsTools !== true) continue;
    routes.set(entry.id, supportsTools === undefined ? {} : { supportsTools });
  }
  return routes;
}

/** Exact OpenRouter routes currently advertised as free, or null when unverified. */
export async function getCurrentOpenRouterFreeRouteIds(options?: {
  requireTools?: boolean;
}): Promise<Set<string> | null> {
  const routes = await getCurrentOpenRouterFreeRouteMetadata(options);
  return routes === null ? null : new Set(routes.keys());
}

interface CacheFile {
  fetchedAt: string;
  data: OpenRouterCatalogEntry[];
}

let inFlightCatalogFetch: Promise<OpenRouterCatalogEntry[]> | null = null;
let retryAfterFetchFailureAt = 0;

function catalogResultFromCache(
  cache: CacheFile | null,
  stale: boolean,
  ttl: number
): {
  data: OpenRouterCatalogEntry[];
  stale: boolean;
  cachedAt: string | null;
  fromCache: boolean;
  cacheTtlMs: number;
} {
  return {
    data: cache?.data ?? [],
    stale,
    cachedAt: cache?.fetchedAt ?? null,
    fromCache: cache !== null,
    cacheTtlMs: ttl,
  };
}

function fetchCatalogOnce(): Promise<OpenRouterCatalogEntry[]> {
  if (inFlightCatalogFetch) return inFlightCatalogFetch;
  const pending = fetchFromAPI();
  inFlightCatalogFetch = pending;
  void pending.then(
    () => {
      if (inFlightCatalogFetch === pending) inFlightCatalogFetch = null;
    },
    () => {
      if (inFlightCatalogFetch === pending) inFlightCatalogFetch = null;
    }
  );
  return pending;
}

/** Read cached catalog from disk. Returns null if not found or unparseable. */
function readCache(): CacheFile | null {
  const filePath = getCacheFilePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const cache = parsed as { fetchedAt?: unknown; data?: unknown };
    if (
      typeof cache.fetchedAt !== "string" ||
      !Number.isFinite(Date.parse(cache.fetchedAt)) ||
      !Array.isArray(cache.data)
    ) {
      return null;
    }
    return {
      fetchedAt: cache.fetchedAt,
      data: cache.data.filter(isCatalogEntry),
    };
  } catch {
    return null;
  }
}

function isCatalogEntry(value: unknown): value is OpenRouterCatalogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0;
}

/** Write catalog to disk cache. */
function writeCache(data: OpenRouterCatalogEntry[], fetchedAt: string): void {
  const filePath = getCacheFilePath();
  const cache: CacheFile = {
    fetchedAt,
    data,
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    console.warn("[OpenRouterCatalog] Failed to write cache:", err);
  }
}

/** Fetch fresh catalog from OpenRouter API. */
async function fetchFromAPI(): Promise<OpenRouterCatalogEntry[]> {
  const res = await fetch(OPENROUTER_API_URL, {
    headers: {
      "User-Agent": "OmniRoute/2.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter API returned ${res.status}: ${res.statusText}`);
  }

  const json: unknown = await res.json();
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("OpenRouter API returned an invalid catalog payload");
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("OpenRouter API catalog payload is missing its data array");
  }
  return data.filter(isCatalogEntry);
}

/**
 * Get OpenRouter model catalog.
 *
 * Returns { data, stale, cachedAt } where:
 * - data: list of models
 * - stale: true if data is from a stale cache (fetch failed)
 * - cachedAt: ISO string of when the source catalog was retrieved
 */
export async function getOpenRouterCatalog(): Promise<{
  data: OpenRouterCatalogEntry[];
  stale: boolean;
  cachedAt: string | null;
  fromCache: boolean;
  cacheTtlMs: number;
}> {
  const ttl = getTTL();
  const cache = readCache();
  const now = Date.now();

  // Return cached data if still within TTL
  if (cache && cache.fetchedAt) {
    const age = now - new Date(cache.fetchedAt).getTime();
    if (age >= 0 && age < ttl) {
      return {
        data: cache.data,
        stale: false,
        cachedAt: cache.fetchedAt,
        fromCache: true,
        cacheTtlMs: ttl,
      };
    }
  }

  // Avoid retrying an unavailable upstream on every short-TTL /v1/models
  // rebuild. Stale entries remain displayable, but callers receive stale=true
  // so they cannot treat them as current free-route authorization.
  if (now < retryAfterFetchFailureAt) return catalogResultFromCache(cache, true, ttl);

  // Cache expired or missing — attempt fresh fetch
  try {
    const data = await fetchCatalogOnce();
    const fetchedAt = new Date().toISOString();
    retryAfterFetchFailureAt = 0;
    writeCache(data, fetchedAt);
    return { data, stale: false, cachedAt: fetchedAt, fromCache: false, cacheTtlMs: ttl };
  } catch (err) {
    retryAfterFetchFailureAt = Date.now() + FETCH_FAILURE_RETRY_MS;
    console.warn("[OpenRouterCatalog] Fetch failed, using stale cache:", err);

    // Stale-if-error: return old cache if available
    if (cache) {
      return {
        data: cache.data,
        stale: true,
        cachedAt: cache.fetchedAt,
        fromCache: true,
        cacheTtlMs: ttl,
      };
    }

    // No cache at all — return empty with error signal
    return { data: [], stale: true, cachedAt: null, fromCache: false, cacheTtlMs: ttl };
  }
}

/**
 * Force-refresh the catalog cache (ignores TTL).
 * Used by admin endpoints and manual refresh actions.
 */
export async function refreshOpenRouterCatalog(): Promise<{
  data: OpenRouterCatalogEntry[];
  ok: boolean;
  error?: string;
}> {
  try {
    const data = await fetchCatalogOnce();
    retryAfterFetchFailureAt = 0;
    writeCache(data, new Date().toISOString());
    invalidateModelCatalogCache();
    return { data, ok: true };
  } catch (err) {
    retryAfterFetchFailureAt = Date.now() + FETCH_FAILURE_RETRY_MS;
    const error = err instanceof Error ? err.message : String(err);
    return { data: [], ok: false, error };
  }
}
