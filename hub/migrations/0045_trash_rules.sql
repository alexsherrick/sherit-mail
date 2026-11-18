-- Trash rules the user makes. The "Webmail" phish reached sam@domain5.example from three domains in a month under one
-- sender name, and an address or domain rule catches none of the next ones. A rule holds words of the sender's NAME and/or of the
-- SUBJECT (lowercase, space-separated, every word must be there, in any order) and a scope: an address, *@domain or * (every account).
-- Matching mail goes to Trash on arrival with no notification. hits and last_hit_at say what each rule has done.
CREATE TABLE IF NOT EXISTS trash_rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (scope, name, subject),
  CHECK (name <> '' OR subject <> '')
);
