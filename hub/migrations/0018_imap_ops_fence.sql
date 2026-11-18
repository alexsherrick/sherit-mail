-- A UNIQUE claim token, and per-account absence tracking.
--
-- 1. claim_token. Fencing on claimed_at was wrong: now() has second resolution, so two claims of the same row can share a value
--  and a stale owner's terminal write then matches the new owner's row. A uuid cannot
--  collide, so the fence is actually a fence.
-- 2. imap_account_absent. The seven-day dwell was measured from the OP's created_at, which is not the same thing at all: an op
--  created eight days ago for a mailbox removed an hour ago was retired within the hour, while the audit log claimed the
--  mailbox had been absent "for over 7 days". Absence is now measured from when the account was
--  first SEEN missing, which is the clock the guarantee was always about.
ALTER TABLE imap_ops ADD COLUMN claim_token TEXT;
CREATE TABLE IF NOT EXISTS imap_account_absent (
  account TEXT PRIMARY KEY,
  first_missing_at TEXT NOT NULL
);
