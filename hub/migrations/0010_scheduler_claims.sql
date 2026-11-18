ALTER TABLE scheduled_actions ADD COLUMN claimed_at TEXT;   -- set when the cron claims a row; stale claims are failed, never silently lost
