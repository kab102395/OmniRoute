/**
 * #6512 (follow-up to #6328 / #6495) — exclude paid-only backends from `auto/*`
 * candidate pools when the operator opts into the `hidePaidModels` setting.
 *
 * PR #6495 added `hidePaidModels` to hide paid models from the `GET /v1/models`
 * listing, but `auto/*` combos could still pick a paid-only backend into their
 * candidate pool → a 402/403 at request time, exactly what #6328 wanted to avoid.
 * This applies the SAME free-model predicate #6495 uses in `catalog.ts` to every
 * virtual auto-combo candidate pool.
 *
 * Kept as a pure, dependency-light function so the filter is unit-testable in
 * isolation without seeding the DB-backed virtual factory.
 */
import { isFreeModel, providerHasFreeModels } from "@/shared/utils/freeModels";

interface PaidFilterCandidate {
  provider: string;
  model: string;
  /** Connections whose fresh exact provider catalog classifies this route as free. */
  freeRouteEligibleConnectionIds?: readonly string[];
  connectionId?: string | null;
  allowedConnectionIds?: string[];
}

/** A candidate is kept only when its provider has documented free models AND the
 * selected model itself qualifies as free — mirrors `shouldHidePaid` in
 * `src/app/api/v1/models/catalog.ts`. */
function isFreeCandidate(
  candidate: PaidFilterCandidate,
  currentOpenRouterFreeRoutes?: ReadonlySet<string>
): boolean {
  if (candidate.provider === "openrouter") {
    if (candidate.model === "free") return (currentOpenRouterFreeRoutes?.size ?? 0) > 0;
    return currentOpenRouterFreeRoutes?.has(candidate.model) === true;
  }
  return (
    providerHasFreeModels(candidate.provider) &&
    isFreeModel(candidate.provider, { id: candidate.model })
  );
}

/**
 * Return the candidate pool filtered to free-only backends when
 * `hidePaidModels` is on; otherwise return the pool unchanged (identity — the
 * default, opt-in-off path). If every candidate is paid the result is empty, and
 * the caller's existing graceful empty-pool path handles it (consistent with the
 * opt-in intent — the operator asked not to route to paid models).
 */
export function filterPaidOnlyCandidates<T extends PaidFilterCandidate>(
  pool: T[],
  hidePaidModels: boolean,
  currentOpenRouterFreeRoutes?: ReadonlySet<string>
): T[] {
  if (!hidePaidModels) return pool;
  const filtered: T[] = [];
  for (const candidate of pool) {
    if (candidate.freeRouteEligibleConnectionIds === undefined) {
      if (isFreeCandidate(candidate, currentOpenRouterFreeRoutes)) filtered.push(candidate);
      continue;
    }

    const eligible = new Set(candidate.freeRouteEligibleConnectionIds);
    if (candidate.connectionId != null) {
      if (eligible.has(candidate.connectionId)) filtered.push(candidate);
      continue;
    }

    const allowedConnectionIds = candidate.allowedConnectionIds ?? [];
    const freeConnectionIds = allowedConnectionIds.filter((id) => eligible.has(id));
    if (freeConnectionIds.length === 0) continue;
    const unchanged =
      freeConnectionIds.length === allowedConnectionIds.length &&
      freeConnectionIds.every((id) => allowedConnectionIds.includes(id));
    filtered.push(
      unchanged ? candidate : ({ ...candidate, allowedConnectionIds: freeConnectionIds } as T)
    );
  }
  return filtered;
}
