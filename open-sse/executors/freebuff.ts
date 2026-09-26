import { randomInt } from "node:crypto";

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import { PROVIDERS } from "../config/constants.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";
import { persistFreebuffResourceObservation } from "@/domain/freebuffObservations";
import {
  buildFreebuffAdmissionHeaders,
  classifyFreebuffAdmission,
  isFreebuffActiveAdmission,
  stableFreebuffInstanceRef,
} from "./freebuffProtocol.ts";

const MODEL_TO_AGENT: Record<string, string> = {
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "z-ai/glm-5.2": "base2-free-glm",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

function generateClientSessionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 13; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

function logSessionObservation(
  log: ExecuteInput["log"],
  connectionId: string | undefined,
  value: unknown
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const session = value as Record<string, unknown>;
  if (session.status !== "active") return;
  const finiteNumber = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  const isoTimestamp = (candidate: unknown) => {
    if (typeof candidate !== "string") return null;
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  const model =
    typeof session.model === "string" && /^[\w./-]{1,160}$/.test(session.model)
      ? session.model
      : null;
  const freebucks =
    session.freebucks && typeof session.freebucks === "object"
      ? (session.freebucks as Record<string, unknown>)
      : null;
  const daily =
    freebucks?.daily && typeof freebucks.daily === "object"
      ? (freebucks.daily as Record<string, unknown>)
      : null;
  const wallet =
    freebucks?.wallet && typeof freebucks.wallet === "object"
      ? (freebucks.wallet as Record<string, unknown>)
      : null;
  const prices =
    freebucks?.prices && typeof freebucks.prices === "object"
      ? (freebucks.prices as Record<string, unknown>)
      : null;
  const instanceRef = stableFreebuffInstanceRef(session.instanceId);
  log?.info?.(
    "freebuff-session-observation",
    JSON.stringify({
      provider: "freebuff",
      connectionId:
        typeof connectionId === "string" && /^[\w-]{1,128}$/.test(connectionId)
          ? connectionId
          : null,
      model,
      instanceRef,
      admittedAt: isoTimestamp(session.admittedAt),
      expiresAt: isoTimestamp(session.expiresAt),
      remainingMs: finiteNumber(session.remainingMs),
      freebucks: freebucks
        ? {
            balance: finiteNumber(freebucks.balance),
            daily: daily
              ? {
                  limit: finiteNumber(daily.limit),
                  spent: finiteNumber(daily.spent),
                  remaining: finiteNumber(daily.remaining),
                  resetAt: isoTimestamp(daily.resetAt),
                  resetTimeZone:
                    typeof daily.resetTimeZone === "string" &&
                    /^[A-Za-z_+-]{1,64}(\/[A-Za-z0-9_+-]{1,64})?$/.test(daily.resetTimeZone)
                      ? daily.resetTimeZone
                      : null,
                }
              : undefined,
            walletBalance: finiteNumber(wallet?.balance),
            modelPrice: model ? finiteNumber(prices?.[model]) : null,
          }
        : null,
      provenance: "OBSERVED_UPSTREAM",
    })
  );
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS.freebuff || { format: "openai" });
  }

  override async execute(input: ExecuteInput) {
    const { model, body, stream, credentials, signal } = input;
    const token = credentials?.apiKey || credentials?.accessToken || "";
    const payload =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    if (!token) {
      return {
        response: new Response(
          JSON.stringify({
            error: { message: "Freebuff Auth Token required", type: "authentication_error" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    const requestedModel =
      typeof model === "string"
        ? model.replace(/^freebuff\//, "")
        : model || "deepseek/deepseek-v4-flash";
    const agentId = MODEL_TO_AGENT[requestedModel] || "base2-free";

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "codebuff/0.1.0 (darwin-arm64)",
    };

    let instanceId = "";
    let runId = "";

    // 1. Session acquisition
    try {
      const sessionRes = await fetch("https://codebuff.com/api/v1/freebuff/session/admission", {
        method: "POST",
        headers: buildFreebuffAdmissionHeaders(token, requestedModel),
        signal,
      });
      const data = await sessionRes.json().catch(() => null);
      const sessionStatus =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).status
          : null;
      const classification = classifyFreebuffAdmission(sessionStatus, sessionRes.status);
      input.log?.info?.(
        "freebuff-admission-classification",
        JSON.stringify({
          classification,
          status: typeof sessionStatus === "string" ? sessionStatus : null,
          httpStatus: sessionRes.status,
        })
      );
      if (sessionRes.ok && classification === "ADMITTED" && isFreebuffActiveAdmission(data)) {
        instanceId = typeof data.instanceId === "string" ? data.instanceId : "";
        if (!instanceId) {
          return this.admissionError(
            502,
            "UNKNOWN",
            "Freebuff returned an active session without an instance ID"
          );
        }
        logSessionObservation(input.log, credentials?.connectionId, data);
        persistFreebuffResourceObservation({
          connectionId: credentials?.connectionId,
          response: data,
        });
      } else {
        return {
          response: this.admissionError(
            sessionRes.ok ? 502 : sessionRes.status,
            classification,
            typeof sessionStatus === "string" ? sessionStatus : undefined
          ),
        };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: sanitizeErrorMessage(`Freebuff session network error: ${msg}`),
              type: "freebuff_admission_transient_provider_failure",
              code: "TRANSIENT_PROVIDER_FAILURE",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        ),
      };
    }

    // 2. Start agent run
    try {
      const runRes = await fetch("https://www.codebuff.com/api/v1/agent-runs", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ action: "START", agentId }),
        signal,
      });
      if (runRes.ok) {
        const runData = (await runRes.json()) as { runId?: string };
        runId = runData.runId || "";
      }
    } catch {}

    // 3. Prepare Chat Payload & Buffy System Prompt
    const incomingMessages: Array<Record<string, unknown>> = Array.isArray(payload.messages)
      ? payload.messages.filter(
          (message): message is Record<string, unknown> =>
            !!message && typeof message === "object" && !Array.isArray(message)
        )
      : [];
    const firstMessage = incomingMessages[0];
    const hasBuffyPrompt =
      incomingMessages.length > 0 &&
      firstMessage?.role === "system" &&
      typeof firstMessage.content === "string" &&
      firstMessage.content.trim().startsWith("You are Buffy");

    if (!hasBuffyPrompt) {
      incomingMessages.unshift({
        role: "system",
        content: "You are Buffy, the strategic coding assistant.",
      });
    }

    const clientSessionId = generateClientSessionId();
    const existingMetadata =
      payload.codebuff_metadata &&
      typeof payload.codebuff_metadata === "object" &&
      !Array.isArray(payload.codebuff_metadata)
        ? (payload.codebuff_metadata as Record<string, unknown>)
        : {};
    const upstreamBody = {
      ...payload,
      model: requestedModel,
      messages: incomingMessages,
      stream: stream !== false,
      codebuff_metadata: {
        run_id: runId,
        cost_mode: "free",
        client_id: clientSessionId,
        freebuff_instance_id: instanceId,
        ...existingMetadata,
      },
    };

    const completionHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
      Accept: "application/json, text/event-stream",
      "x-freebuff-instance-id": instanceId,
      ...(runId ? { "x-codebuff-run-id": runId } : {}),
      "x-codebuff-agent-id": agentId,
    };

    // 4. Chat Completion
    const completionUrl = "https://www.codebuff.com/api/v1/chat/completions";
    const response = await fetch(completionUrl, {
      method: "POST",
      headers: completionHeaders,
      body: JSON.stringify(upstreamBody),
      signal,
    });

    // 5. Finish agent run (background)
    if (runId) {
      void fetch("https://www.codebuff.com/api/v1/agent-runs", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          action: "FINISH",
          runId,
          status: "completed",
          totalSteps: 1,
          directCredits: 0,
          totalCredits: 0,
        }),
      }).catch(() => {});
    }

    return { response };
  }

  private admissionError(
    status: number,
    classification: string,
    upstreamStatus?: string
  ): Response {
    const safeClassification =
      /^(ADMITTED|NO_CAPACITY|ACCOUNT_RESTRICTED|MODEL_RESTRICTED|CONSENT_REQUIRED|TRANSIENT_PROVIDER_FAILURE|SESSION_CONFLICT|UNKNOWN)$/.test(
        classification
      )
        ? classification
        : "UNKNOWN";
    const safeUpstreamStatus =
      upstreamStatus &&
      /^(none|active|ended|country_blocked|model_locked|model_unavailable|banned|ip_capped|rate_limited|spend_limited|purchase_claim_released|purchase_in_use|purchase_capacity|premium_slot_taken|superseded|first_tab_discount_changed|consent_required)$/.test(
        upstreamStatus
      )
        ? upstreamStatus
        : undefined;
    const message = safeUpstreamStatus
      ? `Freebuff admission was not granted (${safeUpstreamStatus})`
      : `Freebuff admission failed (${safeClassification})`;
    return new Response(
      JSON.stringify({
        error: {
          message: sanitizeErrorMessage(message),
          type: `freebuff_admission_${safeClassification.toLowerCase()}`,
          code: safeUpstreamStatus || safeClassification,
        },
      }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }
}
