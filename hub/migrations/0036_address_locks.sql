-- Address locks: an address on my own domains that belongs to the company that first writes to it, so a
-- leaked or resold copy of the address is worth nothing. Only an address with a row here is locked; every other address works as before.
-- A row is made from the app (source app) or on the first mail to an address of the reserved shape x-anything (source pattern).
-- state: active (the claimer and the allow list get in), closed (everything is kept out), released (no lock; the row stays so that an
-- x- address does not lock itself again on its next mail). claim: the organizational domain of the first authenticated sender.
CREATE TABLE IF NOT EXISTS address_locks (
  address TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'closed', 'released')),
  claim TEXT,
  source TEXT NOT NULL CHECK (source IN ('app', 'pattern')),
  created_at TEXT NOT NULL,
  claimed_at TEXT
);
-- Other organizational domains let in to a locked address: added by hand (manual), or by mail the user sent from it (sent).
CREATE TABLE IF NOT EXISTS address_lock_allows (
  address TEXT NOT NULL,
  domain TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'sent')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (address, domain)
);
-- A message a lock kept out: lock_kept 1 until it is let in, lock_root the authenticated organizational domain it came from (NULL when
-- the sender could not be authenticated).
ALTER TABLE messages ADD COLUMN lock_kept INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN lock_root TEXT;
CREATE INDEX IF NOT EXISTS ix_messages_lock_kept ON messages(identity, lock_root) WHERE lock_kept = 1;
