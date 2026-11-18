-- Picture shrinking: every picture of 500 KB or more the hub keeps waits here until the mailhub-shrink Worker has run it
-- through sharp in its container. key is the R2 key (img/<sha256 of the URL>); bytes the stored copy's size when queued.
-- state: pending, done (the stored copy was replaced by the WebP), skipped (no stored copy, or the result was not under 80 %), failed
-- (three tries). shrink_runs keeps the container's running seconds per calendar month for the Worker's month cap and the daily report.
CREATE TABLE IF NOT EXISTS img_shrink (
  key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  ct TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'skipped', 'failed')),
  out_bytes INTEGER,
  tries INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_img_shrink_state ON img_shrink(state, at);
CREATE TABLE IF NOT EXISTS shrink_runs (
  month TEXT PRIMARY KEY,
  seconds REAL NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0
);
