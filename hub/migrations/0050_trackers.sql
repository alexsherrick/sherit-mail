-- Spy trackers and email ads learned from arriving mail and taken from maintained lists.
--
-- trk_obs: every picture the arrival prefetch (or the queue) fetched or found already kept, by URL: its measured size, its pattern
-- (host + up to 4 path segments, token-like ones as *, an 8-hex first host label as *), the sender's organisation, and how many
-- different mails carried it. The learner's evidence; kept 60 days.
CREATE TABLE IF NOT EXISTS trk_obs (
  hk INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  pattern TEXT NOT NULL,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  sender TEXT,
  first_tag TEXT,
  last_tag TEXT,
  mails INTEGER NOT NULL DEFAULT 1,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trk_obs_pattern ON trk_obs(pattern);
CREATE INDEX IF NOT EXISTS ix_trk_obs_last ON trk_obs(last_at);
-- trk_rules: a learned pattern (state watch: recorded, not enforced; on: enforced; off: suspended by its own evidence or a canary;
-- wrong: contradicted while watched) or a veto from the user (kind veto). A veto wins over every list and learned rule.
CREATE TABLE IF NOT EXISTS trk_rules (
  pattern TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('learned', 'veto')),
  state TEXT NOT NULL CHECK (state IN ('watch', 'on', 'off', 'wrong', 'veto')),
  tiny INTEGER NOT NULL DEFAULT 0,
  mails INTEGER NOT NULL DEFAULT 0,
  sender TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  on_at TEXT,
  canary_at TEXT
);
-- trk_verdict: each picture URL the hub blocked by a list or learned rule, which the apps sync (GET /api/trackers) so a mail they
-- render hides it too. gone = 1 is a withdrawn block (a veto, or a learned rule turned off); INSERT OR REPLACE gives it a new seq.
CREATE TABLE IF NOT EXISTS trk_verdict (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hk INTEGER NOT NULL UNIQUE,
  url TEXT NOT NULL,
  name TEXT NOT NULL,
  cls TEXT NOT NULL CHECK (cls IN ('tracker', 'ad')),
  rule TEXT NOT NULL,
  gone INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trk_verdict_rule ON trk_verdict(rule);
CREATE INDEX IF NOT EXISTS ix_trk_verdict_at ON trk_verdict(at);
-- trk_meta: the learner's mode and the active version of each list (JSON values).
CREATE TABLE IF NOT EXISTS trk_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  at TEXT NOT NULL
);
