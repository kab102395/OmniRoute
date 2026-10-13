-- Track requests whose USD cost could not be established separately from zero-cost use.
ALTER TABLE quota_consumption
  ADD COLUMN unknown_usd_count INTEGER NOT NULL DEFAULT 0;
