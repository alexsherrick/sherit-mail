-- Gmail accounts connected through OAuth; the Worker keeps ONLY the encrypted refresh token,
-- a sync cursor and status. Never message content (Gmail stays the mailbox of record).
CREATE TABLE IF NOT EXISTS gmail_accounts (
  email TEXT PRIMARY KEY,
  refresh_token_enc TEXT NOT NULL,   -- AES-GCM ciphertext, base64; key = GMAIL_TOKEN_KEY secret; AAD = email
  refresh_iv TEXT NOT NULL,          -- 12-byte IV, base64
  scope TEXT,                        -- scopes Google actually granted
  status TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  history_id TEXT,                   -- last Gmail historyId the client reported (push detection later)
  created_at TEXT NOT NULL,
  last_minted_at TEXT,               -- last successful access-token mint
  last_error TEXT
);
