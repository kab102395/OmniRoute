# Odysseus integration milestone 1

This document describes the opt-in policy boundary on branch `odysseus-integration`.
OmniRoute remains a provider transport. Odysseus retains intent classification, privacy
authority, workspace/file access, tool execution, validation, and final acceptance.

## Baseline and changes

- Upstream base: `release/v3.8.51` at `9d1a896c6`.
- Integration commits include `efa69d20b`, `94ccf7096`, `b6dee480e`, `e9e56fa30`,
  `890f82a28`, `6d68d0bfe`, and `f1af97a11`.
- Changed files: `src/lib/odysseus/policy.ts`, `src/lib/odysseus/telemetry.ts`,
  `src/lib/odysseus/routeGuard.ts`, the OpenAI chat and Responses routes, the chat
  emergency-fallback gate, durable call-log telemetry, and `tests/unit/odysseus-policy.test.ts`.

## Architecture map

`/v1/chat/completions` and `/v1/responses` parse the request and invoke the Odysseus guard
before injection, model resolution, credential selection, or provider execution. An allowed
pool alias is rewritten to one exact approved `provider/model`; the normal OmniRoute handler
then performs authentication, quota/rate handling, translation, execution, response shaping,
and existing usage/call-log persistence. Odysseus adds response headers and a structured
`pipeline.odysseus` record at terminal call-log persistence. No Odysseus code has filesystem,
shell, browser, Docker, or tool authority.

## Request contract

The integration is disabled unless at least one `X-Odysseus-*` header or the structured
`odysseus_policy` body extension is present. The extension is removed before normal
handler dispatch. Headers are:

| Header                      | Value                                         |
| --------------------------- | --------------------------------------------- |
| `X-Odysseus-Task-Id`        | non-empty task identifier                     |
| `X-Odysseus-Role`           | `coder`, `scout`, `reasoner`, or `compressor` |
| `X-Odysseus-Privacy-Class`  | `public`, `private_source`, or `sensitive`    |
| `X-Odysseus-Free-Only`      | `true` or `false`                             |
| `X-Odysseus-Allowed-Routes` | comma-separated exact `provider/model` IDs    |
| `X-Odysseus-Policy-Version` | non-empty policy version                      |

The body equivalent uses `odysseus_policy` with snake_case keys. Malformed metadata,
unknown roles, and unknown privacy classes fail closed before model/provider resolution.

Operators may provide a complete approval registry with `ODYSSEUS_APPROVALS_JSON`. It
must be a non-empty JSON array containing the documented provider/model/role approval
records; malformed or partial configuration is treated as
the policy-registry-unavailable reason and is denied. If unset, the single built-in route is used.

## Decision flow

1. Parse metadata at `/v1/chat/completions` or `/v1/responses`.
2. Reject sensitive data always; reject `private_source` unless the exact approval says so.
3. Filter by exact role, enabled + approved status, explicitly allowed route, provider
   availability, quota availability, and—when requested—verified free pricing.
4. Pass only the selected exact route to normal OmniRoute routing. Free-only requests are
   excluded from legacy emergency, model-family, and context-overflow model fallback paths;
   same-route transport/account recovery remains available.
5. Add `X-Odysseus-*` response telemetry and persist the same schema in the existing call-log
   pipeline when terminal attempt logging runs. Unknown measurements are `null`, never zero.

Built-in approval is one operator-attested route: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`
for `scout`. OpenRouter's current model catalog listed this exact `:free` ID during the
2026-09-05 verification pass; its retention, training, and risk metadata remain `unknown`.
This is not a claim that provider terms are unchanged. Revalidate those terms before production.

## Redacted denial and telemetry examples

The local preflight acceptance captured this denial before any provider adapter call:

```http
HTTP/1.1 403 Forbidden
X-Odysseus-Policy-Result: PRIVACY_DENIED
X-Odysseus-Free-Route-Verified: false
```

```json
{
  "error": {
    "message": "Odysseus policy denied request: PRIVACY_DENIED",
    "type": "policy_error",
    "code": "PRIVACY_DENIED"
  }
}
```

An allowed terminal call-log record uses the same schema as the response telemetry; measured
fields are populated only from provider usage:

```json
{
  "request_id": "trace-id",
  "odysseus_role": "scout",
  "provider": "openrouter",
  "requested_model": "odysseus-free-scout",
  "actual_model": "nvidia/nemotron-3-super-120b-a12b:free",
  "free_only": true,
  "free_route_verified": true,
  "input_tokens": 42,
  "cached_input_tokens": null,
  "output_tokens": 17,
  "reasoning_tokens": null,
  "total_tokens": 59,
  "usage_source": "measured",
  "success": true,
  "fallback_chain": null
}
```

For a provider/quota failure, the request returns a controlled error and does not enter a
paid or unapproved model fallback. If an approved-route account/transport recovery occurs,
the terminal record retains the actual provider/model and its fallback metadata.

## Testability

Run the focused contract suite:

```bash
node --import tsx/esm --test tests/unit/odysseus-policy.test.ts
```

The suite covers disabled compatibility, structured/header parsing, unknown values,
sensitive/private-source denial, exact role approval, paid/unknown pricing exclusion,
quota exhaustion, provider/model attribution, null telemetry, and measured cache/reasoning
usage projection.

Run the credential-gated live acceptance when a legitimate key is available:

```bash
OMNIROUTE_API_KEY=... npm run test:odysseus-live
```

The script targets the local `/v1/chat/completions` endpoint, uses the exact approved
route, prints a redacted response and telemetry, and exits non-zero on a policy or
provider failure. The OpenRouter credential must already be configured in OmniRoute's
provider connection store; the script does not accept or transmit upstream credentials.
It does not print or persist the optional gateway key. Production Odysseus is not connected.

## Remaining milestone evidence

Before declaring release readiness, add an environment-gated live test using one
operator-provided free API credential. Capture the redacted raw response, authoritative
usage, account identity, latency, and any fallback chain from the existing call-log
pipeline. Also add an adapter-level regression that invokes a fake provider and proves
the sensitive branch has zero provider calls.
