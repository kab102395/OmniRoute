-- Provider-owned credentials for callers of the local OmniRoute gateway.
-- These are not inference provider credentials and are never used upstream.
CREATE TABLE IF NOT EXISTS gateway_client_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gateway_client_credentials_hash ON gateway_client_credentials(token_hash);
