-- The pictures waiting for the mailhub-img Worker (our own WASM shrinker), and when each kept picture was last shown.
-- img_work replaces img_shrink for every picture kept from now on; the container shrinker (mailhub-shrink) reads only img_shrink, so it
-- finds nothing new and starts nothing. A row is claimed ('working') before it is shrunk, so two overlapping cron ticks never take the
-- same picture; a claim older than ten minutes is taken back.
CREATE TABLE IF NOT EXISTS img_work (
  key TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  ct TEXT,
  w INTEGER,
  h INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'working', 'done', 'skipped', 'failed')),
  tries INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  out_bytes INTEGER,
  note TEXT,
  at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_img_work_state ON img_work(state, at);
-- A picture is kept 90 days from the last time it was shown (seen_at, written at most once a day per picture), or from when it was
-- stored if it never was; the hub's daily sweep deletes the rest. sha is the hex after img/ and imgv/.
CREATE TABLE IF NOT EXISTS img_seen (
  sha TEXT PRIMARY KEY,
  stored_at TEXT NOT NULL,
  seen_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_img_seen_last ON img_seen(COALESCE(seen_at, stored_at));
