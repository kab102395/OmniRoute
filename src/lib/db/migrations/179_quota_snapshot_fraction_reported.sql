-- Preserve whether quota remaining was actually reported by the provider.
-- Old snapshots predate this distinction and remain treated as reported.
ALTER TABLE quota_snapshots ADD COLUMN fraction_reported INTEGER NOT NULL DEFAULT 1;
