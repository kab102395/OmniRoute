---
title: "Routing provenance and accounting contract"
version: 3.8.51
lastUpdated: 2026-10-13
---

# Routing provenance and accounting contract

This note describes the additive metadata available to a client integrating with
OmniRoute's OpenAI-compatible chat completions endpoint (`POST /api/v1/chat/completions`).
The normal request remains `{ "model": "…", "messages": [...], "stream": false }`
with the usual bearer authentication. The OpenAI-compatible response body is unchanged.

## Discovering constrained model routes

`GET /api/v1/models` is the unified route catalog. Consumers can ask OmniRoute to filter
the catalog using the assignment's hard requirements instead of implementing provider
catalog or free-tier logic themselves:

```http
GET /api/v1/models?free_only=true&require_tool_calling=true&configuredOnly=true
```

`free_only=true` includes exact OpenRouter variants that are in the fresh authoritative
OpenRouter catalog, exact Hugging Face provider-pinned routes that the current Hugging Face
router catalog marks free, and documented provider free routes with a guaranteed hard stop before
paid overage. The Hugging Face marker may be a temporary promotion and does not establish an
account-level spending guarantee. `require_tool_calling=true` keeps only routes whose
`capability_status.tool_calling.status` is `supported`; unknown capability is not treated as
support. Hugging Face matches are emitted as separate exact provider-pinned model IDs.
`configuredOnly=true` limits results to routes backed by an active configured connection and
allowed by that connection's model rules.

The returned route metadata remains authoritative for the facts it names:

- An exact OpenRouter route such as `openrouter/vendor/model:free` is individually
  selectable and is distinct from its paid sibling. The optional `openrouter/free` entry is
  a dynamic selector, not an exact model identity; its selected model and tool support are
  unknown before execution. It is therefore omitted when tool calling is required.
- `pricing_provenance`, `free_access`, `route_selection`, `route_availability`,
  `capability_status`, token limits, modalities, and any `provider_routes` should be retained
  with the model record. Do not flatten them into the legacy `free`, `pricing`, or boolean
  `capabilities` fields.
- Hugging Face `provider_routes` are scoped to their named serving provider. With a constrained
  catalog query, eligible routes are also emitted as exact IDs such as
  `hf/org/model:provider`, with that host's pricing, capabilities, freshness, and current free
  classification. Dispatch with `X-OmniRoute-Require-Free-Route: true` to recheck this exact
  route's current classification. A free-promotion flag does not prove a spending ceiling.
- `configuredOnly` establishes configured route coverage, not live account eligibility,
  remaining quota, or current execution health. OmniRoute reports those as unknown unless
  an existing provider/account observation establishes them. Catalog discovery does not run
  a billable health probe.

For strict identity, select an exact route and send that exact model id with
`X-OmniRoute-Strict-Model: true`. A dynamic router or a route whose aggregator may choose a
downstream host cannot satisfy a requirement that pins that downstream identity. For free-only
dispatch, also send `X-OmniRoute-Require-Free-Route: true`; this rechecks current free-route
eligibility at dispatch and rejects stale/unverified OpenRouter catalog data. These dispatch
constraints do not establish account quota or a provider hard-stop guarantee beyond the route's
catalog facts.

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
| `X-OmniRoute-Pricing-Retrieved-At`        | UTC timestamp when the referenced price metadata was retrieved, when known.                 |
| `X-OmniRoute-Pricing-Stale`               | `true` or `false` when source freshness can be established.                                 |
| `X-OmniRoute-Usage-Kind`                  | `provider_reported_usage`, `estimated_usage`, or `unknown`.                                 |
| `X-OmniRoute-Fallback-Attempts`           | Count of additional upstream dispatch attempts recorded before the final response.          |

The existing `X-OmniRoute-Provider` and `X-OmniRoute-Model` headers remain for
compatibility; use the `Served-*` headers for final identity. If attempt A fails and
fallback/retry B succeeds, those headers describe B. A failed completion does not receive
successful served-identity headers. The request ID identifies the accepted attempt; a
logical request's correlation ID groups attempts in call-log data, where available.
The served-provider header uses the configured public provider-node prefix when execution
uses a provider node. Its internal node ID is carried separately and must never be used as
the public provider identity. Praxis can validate the exact public identity from completion
headers without querying OmniRoute's management API.

Modality endpoints retain the legacy numeric `X-OmniRoute-Response-Cost` format. When the
provider-reported amount or billable usage/pricing dimensions cannot be established,
`X-OmniRoute-Accounting-Kind` is `unknown`; consumers must not treat the compatibility zero
amount as free-route eligibility. Where local price metadata is used, the pricing retrieval
and freshness headers describe the evidence behind the estimate.

`provider_reported_billed_cost` currently covers xAI's `usage.cost_in_usd_ticks` and
OpenRouter's synchronous `usage.cost`. `zero_cost` means one of those provider-reported
amounts was exactly zero; a missing/local zero calculation does not mean the route was free.
OmniRoute's local model-price table has no exposed version or effective date and may differ
from provider billing, so calculations from it are `estimated_cost`, not an invoice amount.
If no amount is available but provider token usage is known, accounting is `usage_only`; if
neither is known it is `unknown`.

## Streaming completions

The SSE response is opened after OmniRoute has selected the upstream attempt that will produce
the stream. When known, its headers include `X-OmniRoute-Served-Provider`,
`X-OmniRoute-Served-Model`, `X-OmniRoute-Served-Provider-Instance-Id`, and
`X-OmniRoute-Connection-Id`. These identify the selected attempt, but cannot guarantee that the
stream will complete successfully. The response includes `X-OmniRoute-Request-Id` and
`X-OmniRoute-Accounting-Kind: pending`; final usage and cost are not yet known. After the stream
completes, a management-auth client can look up `/api/usage/call-logs/{id}` using that request
ID. The returned call-log summary includes `servedProvider`, `servedModel`, and `accounting` for
a successful attempt. This lookup requires OmniRoute management authentication; it is not
authorized by an ordinary completion API key.

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
