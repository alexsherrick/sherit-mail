CREATE TABLE IF NOT EXISTS identities (
  email TEXT PRIMARY KEY,
  display_name TEXT,
  domain TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  subject_norm TEXT,
  participants TEXT,
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  identity TEXT,
  from_addr TEXT,
  from_name TEXT,
  reply_to TEXT,
  to_addrs TEXT,
  cc_addrs TEXT,
  subject TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  refs TEXT,
  body_text TEXT,
  body_html TEXT,
  snippet TEXT,
  raw_key TEXT,
  size_bytes INTEGER,
  status TEXT,
  ingest_source TEXT,
  gmail_forwarded_at TEXT,
  date_hdr TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_msgid_dir ON messages(message_id, direction) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_threads_last ON threads(last_message_at DESC);
CREATE INDEX IF NOT EXISTS ix_threads_subject ON threads(subject_norm, participants);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  r2_key TEXT NOT NULL,
  content_id TEXT,
  disposition TEXT
);
CREATE INDEX IF NOT EXISTS ix_att_message ON attachments(message_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  message_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_at ON events(at DESC);
