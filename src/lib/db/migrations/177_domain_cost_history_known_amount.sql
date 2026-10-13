-- Preserve requests whose monetary amount could not be established so a finite USD
-- budget does not treat unknown usage as zero spend.
ALTER TABLE domain_cost_history
  ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 1;
