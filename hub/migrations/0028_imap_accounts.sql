-- Work (IMAP) mailboxes added from Settings (the password kept as securely as possible).
-- The password is AES-256-GCM ciphertext. Its key is derived from a Worker secret and is never in this database, and the
-- additional data binds it to this row's address, username and both servers: editing any of those columns here makes the
-- password undecryptable, so the Worker refuses rather than sending it to a new server. Nothing reads the ciphertext but the
-- Worker, at the moment it logs in.
CREATE TABLE IF NOT EXISTS imap_accounts (
  email TEXT PRIMARY KEY,
  label TEXT,
  color TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  pass_enc TEXT NOT NULL,
  pass_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT
);
