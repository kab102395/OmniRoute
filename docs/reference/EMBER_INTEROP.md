---
title: "Routing provenance and accounting contract"
version: 3.8.51
lastUpdated: 2026-09-26
---

# Routing provenance and accounting contract

This note describes the additive metadata available to a client integrating with
OmniRoute's OpenAI-compatible chat completions endpoint (`POST /api/v1/chat/completions`).
The normal request remains `{ "model": "…", "messages": [...], "stream": false }`
with the usual bearer authentication. The OpenAI-compatible response body is unchanged.

## Non-streaming completions

On success, read these headers:

| Header                                    | Meaning                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `X-OmniRoute-Request-Id`                  | ID of the successful attempt's call-log row.                                                |
| `X-OmniRoute-Served-Provider`             | Canonical public provider prefix for the successful execution.                              |
| `X-OmniRoute-Served-Model`                | Concrete model in the final captured outbound provider request.                             |
| `X-OmniRoute-Served-Provider-Instance-Id` | Internal provider-node ID, for diagnostics only.                                            |
| `X-OmniRoute-Connection-Id`               | Selected connection ID when the adapter has one.                                            |
| `X-OmniRoute-Accounting-Kind`             | `provider_reported_billed_cost`, `estimated_cost`, `usage_only`, `zero_cost`, or `unknown`. |
| `X-OmniRoute-Response-Cost`               | USD amount formatted to 10 decimal places; interpret only with accounting kind/source.      |
| `X-OmniRoute-Cost-Currency`               | Currency when an amount is available (`USD`).                                               |
| `X-OmniRoute-Cost-Source`                 | Source of the amount, when present.                                                         |
| `X-OmniRoute-Usage-Kind`                  | `provider_reported_usage`, `estimated_usage`, or `unknown`.                                 |

The existing `X-OmniRoute-Provider` and `X-OmniRoute-Model` headers remain for
compatibility; use the `Served-*` headers for final identity. If attempt A fails and
fallback/retry B succeeds, those headers describe B. A failed completion does not receive
successful served-identity headers. The request ID identifies the accepted attempt; a
logical request's correlation ID groups attempts in call-log data, where available.
The served-provider header uses the configured public provider-node prefix when execution
uses a provider node. Its internal node ID is carried separately and must never be used as
the public provider identity. Praxis can validate the exact public identity from completion
headers without querying OmniRoute's management API.

`provider_reported_billed_cost` currently covers xAI's `usage.cost_in_usd_ticks` and
OpenRouter's synchronous `usage.cost`. `zero_cost` means one of those provider-reported
amounts was exactly zero; a missing/local zero calculation does not mean the route was free.
OmniRoute's local model-price table has no exposed version or effective date and may differ
from provider billing, so calculations from it are `estimated_cost`, not an invoice amount.
If no amount is available but provider token usage is known, accounting is `usage_only`; if
neither is known it is `unknown`.

## Streaming completions

The initial SSE response cannot know which attempt will ultimately finish successfully. It
includes `X-OmniRoute-Request-Id` and `X-OmniRoute-Accounting-Kind: pending`; it deliberately
omits final served identity and final cost. After the stream completes, a management-auth
client can look up `/api/usage/call-logs/{id}` using that request ID. The returned call-log
summary includes `servedProvider`, `servedModel`, and `accounting` for a successful attempt.
This lookup requires OmniRoute management authentication; it is not authorized by an ordinary
completion API key. If that credential is unavailable to the client, streaming final identity
is not available through the completion response itself.

The call-log lookup is also useful for detailed accounting facts. Token usage is stored in the
existing call-log token fields; `accounting` carries `kind`, `amountUsd`, `currency`, `source`,
`pricingProvider`, `pricingModel`, `pricingVersion`, `pricingEffectiveAt`, and `usageKind`.
Pricing version/date are currently null because OmniRoute does not retain them. Provenance
metadata contains provider/model/usage/cost facts only; it does not expose credentials or
authorization headers. Cross-origin browser clients can read the new headers because they are
included in the existing CORS expose-header list.

This metadata does not promise that all providers report billing, that reported cost is an
invoice, or that every adapter exposes a concrete model in its final wire body. When OmniRoute
cannot establish the final outbound model it omits the served-model header rather than
reconstructing one from the request.

Provider references: [OpenRouter chat completion usage schema](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion),
[OpenRouter generation cost details](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation),
and [xAI cost tracking](https://docs.x.ai/developers/cost-tracking).
