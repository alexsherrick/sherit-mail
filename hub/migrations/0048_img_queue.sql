-- Pictures a mail's arrival prefetch has not kept. A row is written for every picture of a mail before its arrival
-- fetch starts, removed once the picture is in R2, and otherwise retried by the minute cron on a schedule set by the arrival, never
-- by an open. While a row exists, /api/img does not ask the sender for that picture at an open: it waits for an arrival fetch in
-- progress, and otherwise answers 404 "withheld". So no open reaches the sender, however its arrival fetch failed.
-- hk: urlHash(new URL(u).href), as img_dims; url is kept to fetch it again and to check a hash collision.
-- kind: new (written ahead, not yet tried), big (over the arrival cap, retried at the open cap), fail (an error, retried 15 min, 2 h and
-- 12 h after it), over (the day's allowance was spent; retried hourly). dead: given up, still withheld at an open.
-- fetching_until: an arrival fetch is under way until then; an open waits for it instead of fetching.
CREATE TABLE IF NOT EXISTS img_queue (
  hk INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dead')),
  kind TEXT NOT NULL DEFAULT 'new' CHECK (kind IN ('new', 'big', 'fail', 'over')),
  tries INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  fetching_until TEXT,
  note TEXT,
  opens INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  last_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_img_queue_due ON img_queue(state, next_at);
