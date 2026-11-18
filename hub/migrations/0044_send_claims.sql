-- A send's idempotency key reserved before the mail goes.
-- sendMail used to look for its key in events and write it only after the mail, its copy and its rows were stored, so a retry of the
-- same send arriving in between found nothing and sent the mail twice. One row per key: 'sending' while it goes, 'sent' with the
-- hub's message id once it has gone, 'failed' when it reached nobody (the only state a retry may take over). Pruned after 30 days.
CREATE TABLE IF NOT EXISTS send_claims (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'failed')),
  message_id TEXT,     -- the hub's own message id, once sent
  platform_id TEXT,    -- the Message-ID the platform gave it
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_send_claims_at ON send_claims(at);
