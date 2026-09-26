---
title: "Provider, Model, and Route Atlas"
version: 3.8.51
lastUpdated: 2026-09-25
---

# Provider, Model, and Route Atlas

**Audit baseline:** `6e1a2144d18f136c0a48f7f2e392ee19bb62042d` (`odysseus-integration`)
**Audit branch:** `omniroute-provider-route-atlas`
**Scope:** source-code and test audit of this commit. No live database or provider calls were used.

This atlas records architecture and provenance, not a second copy of every provider's mutable
model catalog. The provider registry and the executor/translator implementations remain the
authoritative catalogs. User connections, credentials, model overrides, aliases, combos, and health
are runtime/database state and cannot be enumerated from a clean source checkout.

## Inventory boundaries

`open-sse/config/providers/index.ts` composes the registry exported as `REGISTRY`; the registry
generator reports provider aliases and model lists from these entries. At this baseline the registry
object has **273 provider entries**. A registry entry is not equivalent to an active account: an
operator must configure a connection and credentials, and some entries are compatibility or
runtime-provided backends. `src/shared/constants/providers/` separately defines provider families
and auth-oriented metadata. These counts intentionally refer to the runtime registry object, not
the number of all strings that look like provider IDs elsewhere in the repository.

Measured directly by importing `REGISTRY` at this SHA: **2,686 static provider/model declarations**
across **233 providers**, with **1,311 distinct model ID strings** after deduplicating IDs across
providers. This is a declaration count, not a count of distinct physical upstream models or runtime
available models. The registry has **128 provider aliases** (`alias !== id`). The seeded global
model-alias map has **7 entries**, including the **2 deterministic route aliases** below. Runtime DB
aliases and provider-scoped aliases cannot be counted from source alone.

There is no honest single static “all model” count: the routable catalog also includes synced
catalog rows, custom models, passthrough models, API responses, and runtime discovery. Static
provider model declarations live in the `REGISTRY` entries; runtime catalog construction and sync
are in `src/lib/providerModels/modelDiscovery.ts`, `src/lib/modelsDevSync.ts`,
`src/lib/db/models/activeSyncedCatalog.ts`, and `open-sse/services/model.ts`. Provider-specific
discovery endpoints are implemented under `src/app/api/providers/[id]/models/`. These layers may
overlap and must not be summed as disjoint inventories.

## Provider architecture

Provider metadata is split across several purposes:

| Concern                              | Source of truth                                                                                                           | Why it exists                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Provider/model transport declaration | `open-sse/config/providers/index.ts`, `registry/**`                                                                       | Base URLs, protocol format, executor key, static models, declared capabilities, OAuth and headers.  |
| Legacy runtime projection            | `open-sse/config/providerRegistry.ts`                                                                                     | Generates legacy `PROVIDERS`, model lists and ID-to-alias maps for compatible call sites.           |
| Auth / UI family                     | `src/shared/constants/providers/{apikey,oauth,local,web-cookie,noauth,search,audio,system,upstream-proxy,cloud-agent}.ts` | Connection setup, family-specific auth and provider presentation.                                   |
| Executor dispatch                    | `open-sse/executors/index.ts`                                                                                             | Resolves provider/executor identifiers to the transport implementation.                             |
| Format conversion                    | `open-sse/translator/`, `open-sse/transformer/`                                                                           | Converts request and response protocols around executor calls.                                      |
| Provider-specific behavior           | `open-sse/executors/**`, `open-sse/services/**`                                                                           | Auth refresh, signing, endpoint choice, usage/quota parsing, retries and exceptional wire behavior. |

Provider family does not imply one transport or capability set. `RegistryEntry` metadata is
declarative; executors and adapters determine actual behavior. OAuth, API key, cookie/web login,
local, no-auth, upstream-proxy, audio/search, and cloud-agent declarations coexist. Some executors
have provider aliases (for example `freebuff` and `fb`) that instantiate the same executor.

## Normalized request flow

The following order is supported by `src/lib/modelAliasResolver.ts`, `src/lib/odysseus/routeGuard.ts`,
`open-sse/handlers/chatCore.ts`, `open-sse/services/combo.ts`, and `open-sse/executors/base.ts`:

1. The API route performs protocol/CORS handling, request validation and auth/policy gates, then
   delegates to the streaming handler.
2. Request model resolution checks deterministic provider aliases first, then configured DB aliases
   with the built-in `DEFAULT_MODEL_ALIAS_SEED` fallback. A configured combo name remains a combo.
   The DB alias cache lasts 60 seconds. Hidden target models leave the request unchanged.
3. `handleChatCore` applies lifecycle/model policy and determines protocol/format from model,
   connection overrides, inbound API format and provider defaults. A model/route rewrite may update
   the model/provider before executor dispatch.
4. For a combo, `resolveComboTargets` expands strategy/config into ordered provider/model/account
   candidates. `handleSingleModel` executes a target with per-target error handling; fusion is a
   fan-out-and-judge path. Direct requests resolve provider connection credentials in the handler.
5. Credential selection and executor-level key-slot selection choose the account/key. Some routes
   carry explicit connection/key identity; ordinary requests may rotate among eligible connections
   and key slots. Strict selected-key behavior is implemented in `open-sse/executors/base.ts` and
   must preserve the selected slot rather than silently substituting a sibling.
6. The handler applies provider/model request shaping, translator/adapters and executor dispatch.
   Executors may select their own endpoint or perform preflight/session operations. Streaming is
   returned or transformed through protocol-specific response paths.
7. Response translation, usage extraction and cost calculation occur in `chatCore.ts`; call logs,
   usage stats, pending request state, and stream receipts are persisted/updated through usage and DB
   modules. Health, account cooldown and model-lockout updates are driven by failure classification.
8. Route evidence is not universal. Deterministic Codestral routes emit explicit
   `X-OmniRoute-*` identity headers. Combo responses can identify selected connections internally
   through `x-omniroute-selected-connection-id`; ordinary response model echo may preserve the
   caller-facing alias. There is no universal route ID / physical-upstream evidence contract for
   every provider.

This is a normalized outline; modality routes and API families have their own handlers and adapter
paths. It does not imply every provider follows every step.

## Models and aliases

Keep these identities separate:

- **Requested ID:** literal model string from the API client.
- **Logical ID:** caller-facing alias or combo identity used to express intent.
- **Provider model ID:** ID after OmniRoute alias/routing policy selects a provider model.
- **Physical upstream ID:** string placed into the upstream request; provider executors may rewrite it.

Static declarations are in the provider registry. Synced/runtime models have provenance in their
catalog rows and discovery source. A provider-scoped alias maps a local provider-facing model name
to an upstream model ID (`src/lib/db/models/aliases.ts`). Global model aliases map names to
`provider/model`, arrays, or provider/model objects. The built-in seed contains **7 current entries**
at this SHA, including two deterministic Mistral Codestral aliases. Seed migration adds missing
defaults and removes a retired default only when its stored value still matches the old shipped
value, preserving user edits.

Wildcard alias matching is separate from global exact aliases and is implemented in
`open-sse/services/wildcardRouter.ts` and `open-sse/services/model.ts`. It selects a matching target
by specificity. Combo provider wildcards are expanded in `open-sse/services/combo/` and represent
candidate expansion, not the same thing as a model alias.

Capability data comes from registry model declarations, model metadata/capability registries,
models.dev sync, and protocol-specific executor behavior. Fields such as vision/reasoning/context
are not proof that every request shape will work; the executor, translator, and tests are the
behavioral evidence. Pricing and provider limits are separately sourced in `src/lib/usage/` and
provider usage fetchers; missing pricing is not evidence of zero cost.

## Route classes and strictness

| Route class                         | Identity / selection                                                                   | Fallback implications                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Direct provider/model               | Provider prefix or resolved provider/model plus eligible connection selection          | May rotate/fallback according to account and request failure classification.                              |
| Global model alias                  | Alias resolves to provider/model before request handling                               | Subsequent provider/account behavior follows target; an alias alone does not pin credentials.             |
| Provider-scoped alias               | Provider-specific local ID rewrites to upstream ID                                     | Provider remains selected; alias does not add a second provider candidate.                                |
| Wildcard alias                      | Pattern match selects alias target                                                     | The winning pattern and target are runtime/config dependent.                                              |
| Deterministic Codestral             | `mistral/codestral-account-a                                                           | b` carries route metadata, selected connection and slot                                                   | Must not cross into the other named account/slot or another provider. Resolved in `src/lib/deterministicProviderRoutes.ts`. |
| Credential-pinned / strict key slot | Explicit selection carried through executor credential resolution                      | A strict missing/invalid selection fails closed; sibling key fallback changes identity and is disallowed. |
| Combo                               | Strategy produces ordered targets; each target has provider/model/account metadata     | Ordered fallback is intentional except strategy/target strictness and explicit pinning.                   |
| Emergency/model-family fallback     | Separate fallback services such as `emergencyFallback.ts` and `modelFamilyFallback.ts` | Only applies where request policy permits; can change provider/model identity.                            |
| Runtime-discovered/passthrough      | Catalog/discovery or provider accepts unlisted model                                   | Provider determines physical model validity; discovery does not prove availability.                       |
| Compatibility / alternate protocol  | Connection/model target format overrides normal API translation                        | Changes wire format, not necessarily provider/account identity.                                           |
| Session-backed executor             | Executor performs a session/instance acquisition before the actual operation           | Admission/session semantics belong to that executor; do not assume generic token quota behavior.          |

The explicit deterministic routes at this baseline are the two Codestral account aliases declared in
`src/lib/deterministicProviderRoutes.ts`. The alias resolver rewrites both to
`mistral/codestral-latest`, while retaining route identity as non-enumerable symbol metadata. The
resolver sorts active Mistral connections by ID and selects primary or first extra key as the two
ordered candidates. Health checks are per-slot `providerSpecificData.apiKeyHealth`; only explicit
`invalid` is unhealthy. Route headers expose requested/served model, provider, credential alias,
slot and connection ID, but no token.

Combo strategies are declared in `src/shared/constants/routingStrategies.ts`; target expansion and
execution live in `open-sse/services/combo.ts`. Strategies choose ordering/diversity/admission; they
do not make every target interchangeable. Strict/pinned identity, provider policy, model capability
and account eligibility constrain fallback. Audit findings should always be tied to the specific
target route and failure domain.

## Credentials and resource domains

Provider connections are durable DB records. Authentication material includes API key, OAuth access
and refresh tokens, cookies/session material, and provider-specific data. Multiple API key slots are
represented by the primary connection key and `providerSpecificData.extraApiKeys`; per-slot health
is represented where supported by `apiKeyHealth`. Never report credential values in an atlas or
route evidence. `open-sse/executors/base.ts` resolves credential slots and honors strict selected-key
state. Provider-specific executors may use different refresh, signing, or session state.

There is no universal quota unit. Existing mechanisms include API-key request/token rate limiting,
provider/account usage windows, daily/monthly quota fetchers, model lockout, connection cooldown,
provider circuit breaker, local concurrency/availability, and session-backed capacity. The
provider cooldown tracker is an opt-in whole-provider window gate; it is distinct from the normal
provider circuit breaker and per-connection cooldown. Capacity estimates must retain their unit and
source rather than be flattened into a “tokens remaining” number.

## Failure and health hierarchy

| Scope                | State / mechanism                                                        | Recovery                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Request              | Validation, translation, caller abort (499-like), malformed/early stream | Request ends; no provider health implication without upstream evidence.                                                              |
| Key slot             | Slot health / strict selected-key outcome                                | Slot-specific invalidation or operator correction; sibling slot should remain usable.                                                |
| Model                | Model lockout, unavailable-model 404/permission classification           | Model-scoped cooldown or later probe; other models on same connection remain usable.                                                 |
| Connection/account   | `rateLimitedUntil`, `testStatus`, `lastError*`, `backoffLevel`           | Lazy timestamp expiry and clearing after success; terminal banned/credits/expired states require correction or bounded retry policy. |
| Provider             | Circuit breaker `CLOSED/DEGRADED/OPEN/HALF_OPEN`                         | Lazy recovery to half-open after reset; provider-level failures only.                                                                |
| Provider window gate | Opt-in provider cooldown tracker                                         | Failure threshold within configured window then provider cooldown; separate from breaker.                                            |

`open-sse/services/accountFallback.ts::checkFallbackError` classifies status, text, headers,
provider and model into retry/cooldown/lockout behavior. It has explicit provider exceptions.
Generally, 408 and selected 5xx can contribute to provider health; 401/403/429 commonly represent
credential, account, quota, or model issues and should not automatically poison provider health.
402/credit/quota behavior is provider- and key-slot-specific. A notable invariant at the audit
baseline is commit `6e1a2144`: a Mistral 402 selected-key failure must not poison healthy sibling
slots. Preserve this failure-domain specificity when changing shared wrappers. Exact status meaning
must be traced through executor response, handler classification, fallback decision, and state
writer; status alone is insufficient.

## Usage, cost, and route evidence

Non-stream response usage is extracted in `open-sse/handlers/usageExtractor.ts` and processed by
`chatCore.ts`; streaming usage is accumulated in response adapters and finalized in chat-core stream
completion. Cost is computed by `src/lib/usage/costCalculator.ts` from model pricing and service
tier. Provider usage/limit integrations live in `src/lib/usage/providerLimits.ts` and
`open-sse/services/usage/`. These are distinct: a provider-reported balance/limit is not necessarily
the per-call token count, and a computed cost is not necessarily a provider-billed amount.

Call logs and aggregate usage persist request identity, model/provider and usage fields through
`src/lib/usageDb`, `src/lib/db/`, and `src/lib/usage/`. Route attribution quality varies by route
class. Deterministic routes have explicit safe headers; ordinary routes may only preserve selected
provider/model/connection in internal context or logs. No universal response field currently
attests the physical upstream model/session for every provider.

## Freebuff: active API-key provider with per-request instance acquisition

### Implementation and route

At this baseline Freebuff is a first-class provider registry entry (`id: freebuff`, alias `fb`),
classified with API-key gateways, using the dedicated `FreebuffExecutor`. The integration is a
Codebuff-hosted OpenAI-compatible chat endpoint with additional Codebuff session and agent-run
operations. It is not a generic OmniRoute-managed long-lived session pool: the executor requests a
Freebuff instance for each `execute()` call and forwards its returned `instanceId` to one completion
request. OmniRoute does not retain that ID after the call.

Files:

- `open-sse/config/providers/registry/freebuff/index.ts` — provider declaration, nine static models,
  OpenAI format, `apikey` auth type, base URL.
- `src/shared/constants/providers/apikey/gateways.ts` — API-key gateway metadata and UI hint.
- `src/lib/providers/validation.ts` — credential validation calls the session endpoint using the
  first declared model.
- `open-sse/executors/index.ts` — `freebuff` and `fb` dispatch aliases.
- `open-sse/executors/freebuff.ts` — model-to-agent mapping and three-stage request lifecycle.
- `tests/unit/freebuff-provider.test.ts` — registration, validation and mocked execution tests.

The credential is accepted as `credentials.apiKey` or `.accessToken`, then sent as Bearer auth.
No token is persisted by the executor. The upstream endpoint is hardcoded to `www.codebuff.com`.
An `x-freebuff-model` session header carries the selected Freebuff model. The registry model ID is
also sent as completion `model`. The executor maps eight declared IDs to named `base2-free-*`
agents; the ninth Muse Spark model has no explicit map entry and therefore uses generic
`base2-free`.

### Model inventory and provenance

All nine rows below are **declared source-code facts** from the Freebuff registry. Capabilities and
context lengths are declaration metadata, not runtime verification. Physical model vendor/upstream,
actual context limit, pricing and entitlement are **unknown** because OmniRoute does not query or
persist that metadata.

| OmniRoute / Freebuff ID           | Agent mapping               | Declared capabilities | Context | Evidence                     |
| --------------------------------- | --------------------------- | --------------------- | ------: | ---------------------------- |
| `deepseek/deepseek-v4-flash`      | `base2-free-deepseek-flash` | reasoning             | 131,072 | registry + executor map      |
| `deepseek/deepseek-v4-pro`        | `base2-free-deepseek`       | reasoning             | 131,072 | registry + executor map      |
| `openai/gpt-5.6-luna`             | `base2-free-luna`           | reasoning             | 131,072 | registry + executor map      |
| `minimax/minimax-m3`              | `base2-free-minimax-m3`     | vision, reasoning     | 131,072 | registry + executor map      |
| `mimo/mimo-v2.5`                  | `base2-free-mimo`           | reasoning             | 131,072 | registry + executor map      |
| `z-ai/glm-5.2`                    | `base2-free-glm`            | reasoning             | 131,072 | registry + executor map      |
| `crof/kimi-k3-eco`                | `base2-free-kimi-k3-eco`    | vision, reasoning     | 131,072 | registry + executor map      |
| `anthropic/claude-fable-5`        | `base2-free-fable`          | vision, reasoning     | 131,072 | registry + executor map      |
| `meta/muse-spark-1.2-contributor` | fallback `base2-free`       | reasoning             | 131,072 | registry + executor fallback |

The physical provider behind each branded ID, actual supported reasoning modes, tools, audio/video,
PDF/document behavior, per-model Freebucks cost, and duration are **unknown** to this implementation.
Vision declarations exist for three models. No Freebuff-specific request adaptation declares tools
or multimodal transformations in the executor; the common payload is forwarded with messages and
model. That does not prove upstream unsupported.

### Per-call execution and lifecycle

1. Missing token returns local 401 before network I/O.
2. The executor calls `POST /api/v1/freebuff/session` with Bearer token and
   `x-freebuff-model`. Failure returns the endpoint's status; transport failure becomes 502.
3. On success, it reads only `instanceId`. It does not read a session ID, duration, expiration,
   remaining time, balance, cost, queue, or status.
4. It posts `action: START` to `/api/v1/agent-runs` with the model-selected agent. A thrown error
   and non-success HTTP response are ignored; `runId` remains empty if no successful JSON ID.
5. It generates a random 13-character lowercase base-36 `client_id`, adds the Buffy system prompt
   if not already present, and posts the OpenAI-compatible completion with `cost_mode: free`,
   `freebuff_instance_id`, optional run ID, and instance/run/agent headers.
6. If `runId` exists, it issues a fire-and-forget `FINISH` request reporting one completed step and
   zero credits. It does not await or record finish success.
7. It returns the completion `Response` directly to the caller path. There is no executor cleanup
   hook or stored Freebuff timer/session object.

The timer question is therefore **UNKNOWN / not represented**. The code proves the time ordering
of session acquisition before completion dispatch, but not when Codebuff begins billing/entitlement
time. It could start at instance admission, first inference, or another upstream event. OmniRoute
does not observe `started_at`, `expires_at`, duration, elapsed or remaining seconds. Wall-clock versus
active-compute accounting, one-hour duration, model/route switching, multiple concurrent instances,
expiration behavior, grace period, process restart, reconnect reuse, and desktop/CLI sharing are all
unknown. The only non-destructive ways to establish them are upstream session documentation or
read-only responses/usage records for requests already made; a controlled request would consume
entitlement and was not performed in this audit.

Retry behavior: OmniRoute's executor has no explicit retry around session admission, run start, or
completion. Generic outer retry/fallback may act on returned error status according to the normal
provider error policy; whether a failed completion consumed Freebucks is unknown. The executor does
not itself select another provider. A combo or other outer route may divert if configured; that is
route policy, not a Freebuff fallback. No queue status is captured. Session endpoint transport errors
become 502, but run-start failure does not block completion. Completion transport errors propagate
from `fetch` to the outer handler. Agent-run finish failures are swallowed.

Daily reset and balance behavior are **not implemented or observed**. There is no Freebuff usage
fetcher, Freebucks counter, allowance, persisted session, or capacity record in OmniRoute at this
baseline. Generic token usage/cost processing can account for completion response usage if returned,
but it does not equal Freebucks spent and no Freebuff-specific cost metadata is declared.

### Capacity ledger design (not implemented)

Do not infer a one-hour session or derive Freebucks spent from token usage. A compatible ledger should
be a provider-resource observation layer in existing DB domains, keyed by provider + connection +
upstream instance/session ID where available, with separate observations for `balance`,
`session_admission_cost`, `duration`, `started_at`, and `expires_at`. Each value should carry
`value_kind: OBSERVED | DECLARED | DERIVED`, source, observed timestamp, and confidence. Store no
credential/auth material. Derived values such as `floor(observed_balance / declared_admission_cost)`
must remain derived and must be recomputable from their source observations.

Before persistence is justified, the upstream must provide stable safe identifiers and authoritative
balance/session timing semantics. Then ledger snapshots could include provider/resource identity,
connection ID, route/model, session/instance ID, start/expiry/duration, observed balances, admission
cost, availability/queue status, upstream identity, last success/failure, fallback observation and
source. Active-session, expiring-session, expired-session, and low/exhausted-balance views should be
derived from observed timestamps/balances, not become an independent health state machine. No schema
or live DB mutation is appropriate while the source facts are absent.

### Freebuff route evidence and gaps

Current execution constructs internal headers/metadata with the instance ID, selected Freebuff model,
agent ID, and optionally run ID for Codebuff. It emits no OmniRoute route ID, response telemetry,
session duration, Freebucks balance/spend, queue, expiry, fallback flag, or physical-upstream model.
Neither instance ID nor run ID is persisted by OmniRoute in this executor. The random client session
ID is sent upstream only. Current accounting is ordinary model/token usage when upstream returns
usage; capacity accounting is absent. Tests in this audit mock `fetch` and verify the lifecycle and
that run-start failure does not prevent completion; they make no live calls.

## Provenance and maintenance method

Use `REGISTRY` and source symbols as the declaration source; confirm behavior in executor/handler
code and tests; use DB/runtime observations only when explicitly available and non-destructive. Mark
each catalog value as source-code declaration, runtime observation, or derived calculation. Preserve
unknowns rather than filling them from model branding or assumptions. Provider/model counts should
be generated from the registry/discovery APIs for the specific runtime snapshot; never add hand-copied
catalog tables here. For history rationale, inspect the introducing/fixing commit and its test,
especially when modifying account/key failure domains.

## Audit unknowns and limits

This source audit did not inspect a live database, provider credentials, active connections, current
aliases/combos, runtime-discovered catalogs, current account health, or any Freebuff entitlement
records. Those values are environment-dependent and intentionally are not represented as facts here.
The provider registry count and nine static Freebuff model declarations are source facts at the
baseline SHA; provider connections and active routability are runtime facts requiring a safe
read-only snapshot.

## Hardening finding

The session-admission error path previously returned the upstream response body verbatim, and the
network-error branch returned the raw exception message. This crossed OmniRoute's error-sanitization
boundary and could expose credential-like text echoed by the upstream or transport. The audit change
now bounds the upstream text to 500 characters and runs both error paths through
`sanitizeErrorMessage`; a mocked test pins redaction and the existing HTTP status behavior.
