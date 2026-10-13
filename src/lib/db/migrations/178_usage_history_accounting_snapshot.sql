-- Preserve the per-attempt pricing facts used when usage occurred. Budget
-- checks must not recalculate historical spend using today's price catalog.
ALTER TABLE usage_history ADD COLUMN request_id TEXT;
ALTER TABLE usage_history ADD COLUMN accounting_json TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_history_request_id
  ON usage_history(request_id) WHERE request_id IS NOT NULL;
