---
title: "Deterministic Provider Routes"
---

# Deterministic Mistral qualification routes

OmniRoute keeps `mistral/codestral-latest` as the normal load-balanced Codestral route. For callers that need stable qualification attribution, these aliases are available:

- `mistral/codestral-account-a` → deterministic route ID `mistral-codestral-account-a`
- `mistral/codestral-account-b` → deterministic route ID `mistral-codestral-account-b`

The aliases resolve the active Mistral credential candidates in stable connection-ID order, with each connection's primary key before its first extra key. If the requested candidate is unavailable, the alias returns an unavailable response; it does not fall back to another credential or to the load-balanced route.

The OpenAI-compatible endpoint remains `/v1/chat/completions`. Streaming bodies and tool/function-calling fields are passed through unchanged. Responses for deterministic routes include these non-secret headers:

- `X-OmniRoute-Route-Id`
- `X-OmniRoute-Requested-Model`
- `X-OmniRoute-Served-Model`
- `X-OmniRoute-Provider`
- `X-OmniRoute-Credential-Alias`
- `X-OmniRoute-Key-Slot`

No API key material is included in these headers, response bodies, or route metadata. Normal callers should continue using `mistral/codestral-latest`.
