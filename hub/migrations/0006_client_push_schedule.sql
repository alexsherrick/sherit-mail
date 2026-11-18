-- Push subscriptions, the scheduler (snooze / send later / reminders), account presentation,
-- Gatekeeper (blocked / accepted senders across accounts) and per-client preferences. No Gmail message content anywhere.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scheduled_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('snooze','send_later','reminder')),
  account TEXT NOT NULL,            -- 'hub' | gmail address | imap address
  ref TEXT,                         -- thread/message id in that account's namespace
  due_at TEXT NOT NULL,
  payload TEXT,                     -- JSON (send_later: encrypted outgoing draft; reminder: note)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed | cancelled
  created_at TEXT NOT NULL,
  done_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_scheduled_due ON scheduled_actions(status, due_at);
CREATE TABLE IF NOT EXISTS sender_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,            -- exact address or *@domain, lowercase
  action TEXT NOT NULL CHECK (action IN ('block','accept','priority')),
  scope TEXT NOT NULL DEFAULT '*',  -- '*' or an account
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sender_rules ON sender_rules(pattern, scope);
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE gmail_accounts ADD COLUMN label TEXT;
ALTER TABLE gmail_accounts ADD COLUMN color TEXT;
ALTER TABLE gmail_accounts ADD COLUMN last_poll_at TEXT;
ALTER TABLE gmail_accounts ADD COLUMN poll_history_id TEXT;   -- the Worker's own cursor for new-mail detection (push/gatekeeper)
