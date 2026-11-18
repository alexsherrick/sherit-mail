-- Gatekeeper sender state (address-only routing metadata, no content) + sender-level category overrides that teach the categorizer.
CREATE TABLE IF NOT EXISTS known_senders (
  address TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | blocked
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  first_account TEXT,
  seen_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_known_senders_status ON known_senders(status, last_seen_at);
ALTER TABLE sender_rules ADD COLUMN category TEXT;   -- personal | notifications | newsletters (sender → category override)
