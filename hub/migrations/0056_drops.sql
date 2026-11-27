-- Big files as links: a file too big for the way its message goes out is uploaded to R2 (drop/<id>/<name>) and the
-- message carries https://<hub>/f/<token>; the row says what it is, until when it is kept, and how often it was fetched.
CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  upload_id TEXT,
  state TEXT NOT NULL DEFAULT 'uploading',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  last_download_at TEXT
);
CREATE INDEX IF NOT EXISTS drops_expires ON drops (expires_at);
