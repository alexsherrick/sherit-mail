-- Drafts: what the user is writing, kept by the hub for every account and synced to every device.
-- The content (recipients, text, file list) is sealed with the drafts key, as Send later's drafts are. The columns beside it are what the
-- Drafts list shows. seq orders every change (insert, edit, delete) for the devices' sync cursor. A sent or discarded draft stays as a
-- tombstone (deleted = 1, no content) for 30 days, so a device that was away learns it is gone.
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL DEFAULT 1,
  seq INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'new',
  thread_key TEXT,
  from_addr TEXT,
  to_addrs TEXT,
  subject TEXT,
  snippet TEXT,
  n_files INTEGER NOT NULL DEFAULT 0,
  enc TEXT,
  iv TEXT,
  device TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_drafts_seq ON drafts(seq);
CREATE INDEX IF NOT EXISTS ix_drafts_deleted ON drafts(deleted, updated_at);
-- A draft's files, uploaded once when attached (R2 drafts/<draft>/<file>), deleted with the draft.
CREATE TABLE IF NOT EXISTS draft_files (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_draft_files_draft ON draft_files(draft_id);
