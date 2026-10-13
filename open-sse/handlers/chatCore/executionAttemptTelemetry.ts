/** Whether an executor attempt moved to a different account or model route. */
export function isExecutionRouteFallback(
  previous: Record<string, unknown> | null,
  current: Record<string, unknown>
): boolean {
  if (current.routeLeg === "proxy_fallback") return true;
  if (!previous) return false;

  const previousConnectionId = previous.connectionId;
  const currentConnectionId = current.connectionId;
  if (
    typeof previousConnectionId === "string" &&
    typeof currentConnectionId === "string" &&
    previousConnectionId !== currentConnectionId
  ) {
    return true;
  }

  const previousRouteModel = previous.routeModel;
  const currentRouteModel = current.routeModel;
  return (
    typeof previousRouteModel === "string" &&
    typeof currentRouteModel === "string" &&
    previousRouteModel !== currentRouteModel
  );
}

/** Executor attempts after the first are retries, including constrained route failover. */
export function getExecutionRetryCount(attemptCount: number): number {
  return Number.isFinite(attemptCount) ? Math.max(0, Math.floor(attemptCount) - 1) : 0;
}
