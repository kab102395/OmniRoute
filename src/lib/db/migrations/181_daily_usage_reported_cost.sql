-- Preserve provider-reported charges separately from catalog estimates when
-- per-request usage history is compacted into daily summaries.
ALTER TABLE daily_usage_summary ADD COLUMN provider_reported_cost REAL;
ALTER TABLE daily_usage_summary ADD COLUMN provider_reported_requests INTEGER;
