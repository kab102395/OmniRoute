import { errorResponse } from "@omniroute/open-sse/utils/error";
import { evaluateOdysseusPolicy, parseOdysseusMetadata, type PolicyDecision } from "./policy";
import { createOdysseusTelemetry } from "./telemetry";

function responseWithTelemetry(
  response: Response,
  decision: PolicyDecision,
  requestModel: string | null
) {
  if (decision.result === "disabled") return response;
  const telemetry = createOdysseusTelemetry(
    decision,
    response.headers.get("x-request-id"),
    requestModel
  );
  const headers = new Headers(response.headers);
  headers.set("X-Odysseus-Policy-Result", telemetry.policy_result);
  if (telemetry.provider) headers.set("X-Odysseus-Provider", telemetry.provider);
  if (telemetry.actual_model) headers.set("X-Odysseus-Actual-Model", telemetry.actual_model);
  headers.set("X-Odysseus-Free-Route-Verified", String(telemetry.free_route_verified));
  headers.set("X-Odysseus-Telemetry", JSON.stringify(telemetry));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface OdysseusGuardResult {
  decision: PolicyDecision;
  body: Record<string, unknown>;
  response: Response | null;
}

/**
 * Enforce the policy before `handleChat` performs model resolution or provider work.
 * The `odysseus-free-*` aliases are filtered candidate pools, not autonomous routers.
 */
export function enforceOdysseusPolicy(headers: Headers, body: unknown): OdysseusGuardResult {
  const parsed = parseOdysseusMetadata(headers, body);
  const bodyRecord =
    body && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>) }
      : {};
  const model = typeof bodyRecord.model === "string" ? bodyRecord.model : null;
  const decision = evaluateOdysseusPolicy(
    parsed,
    undefined,
    model?.startsWith("odysseus-free-") ? null : model
  );
  if (decision.result === "disabled") return { decision, body: bodyRecord, response: null };
  if (decision.result === "denied") {
    return {
      decision,
      body: bodyRecord,
      response: responseWithTelemetry(
        errorResponse(403, `Odysseus policy denied request: ${decision.reason}`, {
          type: "policy_error",
          code: decision.reason ?? "POLICY_DENIED",
        }),
        decision,
        model
      ),
    };
  }
  if (model?.startsWith("odysseus-free-")) {
    bodyRecord.model = `${decision.selectedRoute?.provider}/${decision.selectedRoute?.model}`;
  }
  delete bodyRecord.odysseus_policy;
  return { decision, body: bodyRecord, response: null };
}

export function addOdysseusTelemetryHeaders(
  response: Response,
  decision: PolicyDecision,
  requestModel: string | null
): Response {
  return responseWithTelemetry(response, decision, requestModel);
}
