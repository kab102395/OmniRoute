/** Maximum age for synchronized provider capability facts used to admit tool routes. */
export const SYNCED_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isFreshCatalogTimestamp(
  value: string | null | undefined,
  now = Date.now(),
  maxAgeMs = SYNCED_MODEL_CATALOG_MAX_AGE_MS
): boolean {
  const retrievedAt = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(retrievedAt) && retrievedAt <= now && now - retrievedAt <= maxAgeMs;
}
