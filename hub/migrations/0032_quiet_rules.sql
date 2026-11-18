-- Don't-notify rules: mail from `sender` whose subject contains `subject` arrives as usual, but raises no notification
-- on any device. `sender` is an exact address or *@domain, lowercase; `subject` '' means any subject from that sender, otherwise a
-- lowercase phrase matched inside the subject (Re:/Fwd: prefixes ignored). `hits` counts the notifications each rule has stopped.
CREATE TABLE IF NOT EXISTS quiet_rules (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_quiet_rules ON quiet_rules(sender, subject);
