-- The work mailbox synced by our own IMAP client. Messages land in the hub store with their IMAP
-- coordinates so flags and moves can be written back; imap_folders holds per-folder cursors; imap_ops is the write-back queue.
ALTER TABLE messages ADD COLUMN imap_account TEXT;
ALTER TABLE messages ADD COLUMN imap_folder TEXT;
ALTER TABLE messages ADD COLUMN imap_uidvalidity INTEGER;
ALTER TABLE messages ADD COLUMN imap_uid INTEGER;
ALTER TABLE messages ADD COLUMN imap_flags TEXT;
CREATE INDEX IF NOT EXISTS ix_messages_imap ON messages(imap_account, imap_folder, imap_uidvalidity, imap_uid);
CREATE TABLE IF NOT EXISTS imap_folders (
  account TEXT NOT NULL,
  folder TEXT NOT NULL,
  role TEXT,                         -- inbox | sent | trash | archive | junk | drafts | snoozed | null
  uidvalidity INTEGER,
  uidnext INTEGER,
  highwater INTEGER NOT NULL DEFAULT 0,   -- highest UID stored
  lowwater INTEGER,                        -- lowest UID stored (backfill goes below it)
  exists_count INTEGER,
  last_sync_at TEXT,
  last_sweep_at TEXT,
  last_error TEXT,
  PRIMARY KEY (account, folder)
);
CREATE TABLE IF NOT EXISTS imap_ops (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  message_id TEXT NOT NULL,          -- hub messages.id
  op TEXT NOT NULL,                  -- seen | unseen | flag | unflag | trash | archive | restore | snooze
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  done_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_imap_ops_pending ON imap_ops(status, account, created_at);
