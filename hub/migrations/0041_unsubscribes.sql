-- Unsubscribe jobs. One row per tap on Unsubscribe, sent by the app once its 5 s Undo has passed. The hub works it in
-- the background: it reads the mail's List-Unsubscribe headers itself, tries one-click, the list's email address, then its page, and
-- records what the list answered; then it trashes the sender's other promotions in every account (never its orders).
CREATE TABLE IF NOT EXISTS unsubscribes (
  id TEXT PRIMARY KEY,                    -- the app's own job id: a retried request is the same job
  created_at TEXT NOT NULL,
  account TEXT NOT NULL,                  -- 'hub', or a connected Gmail address
  thread_id TEXT NOT NULL,                -- the conversation unsubscribed from
  sender TEXT NOT NULL,                   -- its sender's address, lowercase
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | sweeping | done
  outcome TEXT,                           -- accepted | email_sent | confirmed | needs_you | spam | no_link | gone | error
  method TEXT,                            -- one-click | email | page | none
  answer TEXT,                            -- what happened, as it happened ("list.example answered 200")
  url TEXT,                               -- the list's page, for a person to open when it needs one
  step TEXT,                              -- the contact last started, so a run cut short never sends the email twice
  tries INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  done_at TEXT,
  swept INTEGER NOT NULL DEFAULT 0,       -- the sender's other mail moved to Trash
  kept INTEGER NOT NULL DEFAULT 0,        -- the sender's other mail left where it was (orders, receipts and the like)
  sweep_left TEXT                         -- JSON: what the sweep still has to look at
);
CREATE INDEX IF NOT EXISTS ix_unsubscribes_status ON unsubscribes(status, created_at);
