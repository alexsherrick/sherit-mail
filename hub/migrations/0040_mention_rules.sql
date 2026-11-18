-- "Delete unless it mentions" rules. New mail in a Gmail account from a matching sender is read in full: it stays (or
-- leaves Spam for the inbox) when its text mentions one of the words, and goes to Gmail's trash when it does not. A separate table from
-- sender_rules on purpose: code that does not know it deletes nothing, and sender_rules' accept/category rows cannot outrank it.
-- pattern: an address, or *@domain (that domain and its subdomains), lowercase. scope: a Gmail account, or '*' for every Gmail account.
-- words: a JSON array of words or phrases. kept / dropped / last_at: what the rule has done, for Settings.
CREATE TABLE IF NOT EXISTS mention_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '*',
  words TEXT NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mention_rules ON mention_rules(pattern, scope);
-- One decision per message, claimed (decision 'claimed') before anything is done to it, then set to what was done: kept, rescued (moved
-- from Spam to the inbox), dropped (to Gmail's trash) or unread (could not be read, so kept). A message already here is never decided
-- again: not by an overlapping run, not by the poll's catch-up after an expired cursor, not after the user restores it by hand.
CREATE TABLE IF NOT EXISTS mention_decisions (
  account TEXT NOT NULL,
  id TEXT NOT NULL,
  rule_id TEXT,
  decision TEXT NOT NULL,
  from_addr TEXT,
  subject TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (account, id)
);
CREATE INDEX IF NOT EXISTS ix_mention_decisions_at ON mention_decisions(at);
