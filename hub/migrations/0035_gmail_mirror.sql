-- The hub follows Gmail and every device follows the hub.
--  A device closed for days used to replay Gmail's history itself and download every new message itself; now
-- the hub keeps each message's METADATA (labels, the 13 headers the client lists by, the snippet) for the 90-day window plus every
-- unread inbox message, and its changes ride the same thread_changes feed domain mail uses, as 'g|<account>|<message id>'.
-- No bodies, attachments, raw MIME or drafts are stored. Gmail stays the system of record.
CREATE TABLE IF NOT EXISTS gmail_messages (
  account TEXT NOT NULL,
  id TEXT NOT NULL,                 -- Gmail message id
  thread_id TEXT NOT NULL,
  labels TEXT NOT NULL,             -- JSON array, absolute: the latest a history record or a get reported
  internal_date INTEGER,            -- ms since epoch
  meta TEXT,                        -- the message resource from messages.get format=metadata; NULL marks a STUB (labels only)
  history_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account, id)
);
CREATE INDEX IF NOT EXISTS ix_gmail_messages_thread ON gmail_messages(account, thread_id);
CREATE INDEX IF NOT EXISTS ix_gmail_messages_date ON gmail_messages(account, internal_date);
-- Inserts and real changes feed the devices. A deletion Gmail reports writes its own 'd' event in the same batch; pruning writes none,
-- because a device keeps its copy of a message that only aged out of the hub's window.
CREATE TRIGGER IF NOT EXISTS gmail_messages_ins AFTER INSERT ON gmail_messages FOR EACH ROW
BEGIN INSERT INTO thread_changes (thread_id, op, at) VALUES ('g|' || NEW.account || '|' || NEW.id, 'u', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER IF NOT EXISTS gmail_messages_upd AFTER UPDATE ON gmail_messages FOR EACH ROW WHEN NEW.labels IS NOT OLD.labels OR NEW.meta IS NOT OLD.meta OR NEW.thread_id IS NOT OLD.thread_id
BEGIN INSERT INTO thread_changes (thread_id, op, at) VALUES ('g|' || NEW.account || '|' || NEW.id, 'u', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
ALTER TABLE gmail_accounts ADD COLUMN mirror_history_id TEXT;
ALTER TABLE gmail_accounts ADD COLUMN mirror_state TEXT;       -- NULL until the hub starts; 'backfill' | 'ready'
ALTER TABLE gmail_accounts ADD COLUMN mirror_progress TEXT;    -- JSON: backfill listing and ids still to fetch, ids owed in steady state
ALTER TABLE gmail_accounts ADD COLUMN mirror_synced_at TEXT;   -- the last run that read Gmail's history to the end
