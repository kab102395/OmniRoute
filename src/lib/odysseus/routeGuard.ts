import { errorResponse } from "@omniroute/open-sse/utils/error";
import { evaluateOdysseusPolicy, parseOdysseusMetadata, type PolicyDecision } from "./policy";
import { createOdysseusTelemetry, withOdysseusUsage } from "./telemetry";

function responseWithTelemetry(
  response: Response,
  decision: PolicyDecision,
  requestModel: string | null,
  usage?: Parameters<typeof withOdysseusUsage>[1]
) {
  if (decision.result === "disabled") return response;
  let telemetry = createOdysseusTelemetry(
    decision,
    response.headers.get("x-request-id"),
    requestModel
  );
  if (usage) telemetry = withOdysseusUsage(telemetry, usage);
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

export async function addOdysseusTelemetryHeaders(
  response: Response,
  decision: PolicyDecision,
  requestModel: string | null
): Promise<Response> {
  if (decision.result === "disabled" || !response.body) {
    return responseWithTelemetry(response, decision, requestModel);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    return responseWithTelemetry(response, decision, requestModel);
  }
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const usage = payload.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      return responseWithTelemetry(response, decision, requestModel);
    }
    const details = usage as Record<string, unknown>;
    const promptDetails =
      details.prompt_tokens_details && typeof details.prompt_tokens_details === "object"
        ? (details.prompt_tokens_details as Record<string, unknown>)
        : {};
    const completionDetails =
      details.completion_tokens_details && typeof details.completion_tokens_details === "object"
        ? (details.completion_tokens_details as Record<string, unknown>)
        : {};
    const numberOrNull = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return responseWithTelemetry(response, decision, requestModel, {
      input_tokens: numberOrNull(details.prompt_tokens ?? details.input_tokens),
      cached_input_tokens: numberOrNull(
        details.cached_input_tokens ??
          details.cache_read_input_tokens ??
          promptDetails.cached_tokens
      ),
      output_tokens: numberOrNull(details.completion_tokens ?? details.output_tokens),
      reasoning_tokens: numberOrNull(
        details.reasoning_tokens ?? completionDetails.reasoning_tokens
      ),
      total_tokens: numberOrNull(details.total_tokens),
      usage_source: "measured",
    });
  } catch {
    return responseWithTelemetry(response, decision, requestModel);
  }
}
