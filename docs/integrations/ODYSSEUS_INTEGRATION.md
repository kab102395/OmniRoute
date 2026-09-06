# Odysseus integration milestone 1

This document describes the opt-in policy boundary on branch `odysseus-integration`.
OmniRoute remains a provider transport. Odysseus retains intent classification, privacy
authority, workspace/file access, tool execution, validation, and final acceptance.

## Baseline and changes

- Upstream base: `release/v3.8.51` at `9d1a896c6`.
- Integration commit: `efa69d20b` (`feat(odysseus): add fail-closed policy boundary`).
- Changed files: `src/lib/odysseus/policy.ts`, `src/lib/odysseus/telemetry.ts`,
  `src/lib/odysseus/routeGuard.ts`, the OpenAI chat and Responses routes, the chat
  emergency-fallback gate, and `tests/unit/odysseus-policy.test.ts`.

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

## Decision flow

1. Parse metadata at `/v1/chat/completions` or `/v1/responses`.
2. Reject sensitive data always; reject `private_source` unless the exact approval says so.
3. Filter by exact role, enabled + approved status, explicitly allowed route, provider
   availability, quota availability, and—when requested—verified free pricing.
4. Pass only the selected exact route to normal OmniRoute routing. Free-only requests are
   excluded from the legacy emergency paid/fallback path.
5. Add `X-Odysseus-*` response telemetry. Unknown measurements are `null`, never zero.

Built-in approval is one operator-attested route: `openrouter/nvidia/openai/gpt-oss-120b:free`
for `scout`. Its retention, training, and risk metadata remain `unknown`; this is not a
claim that current provider terms are unchanged. Revalidate those terms before production.

## Testability

Run the focused contract suite:

```bash
node --import tsx/esm --test tests/unit/odysseus-policy.test.ts
```

The suite covers disabled compatibility, structured/header parsing, unknown values,
sensitive/private-source denial, exact role approval, paid/unknown pricing exclusion,
quota exhaustion, provider/model attribution, and null telemetry.

An actual external provider request is intentionally not claimed here: it requires a
legitimate operator-provided API key and current provider terms. Production Odysseus is
not connected. No credentials are stored in this repository.

## Remaining milestone evidence

Before declaring release readiness, add an environment-gated live test using one
operator-provided free API credential. Capture the redacted raw response, authoritative
usage, account identity, latency, and any fallback chain from the existing call-log
pipeline. Also add an adapter-level regression that invokes a fake provider and proves
the sensitive branch has zero provider calls.
