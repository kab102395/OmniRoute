-- Record the redacted upstream credential slot used for each provider attempt.
-- Values are limited by the call-log writer to `primary` or `extra_N`; the
-- actual credential is never persisted.
ALTER TABLE call_logs ADD COLUMN provider_key_slot TEXT;
