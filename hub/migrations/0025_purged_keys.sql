-- Dispositions for R2 objects that must never be projected again. Two reasons, one table.
--
-- 'purged': the user deliberately removed the message. The orphan sweep asks R2 "is there a message row for this
-- key?" and enqueues anything that answers no -- and a purged message answers no for the same reason an unindexed one
-- does, because the row is gone. It is not hypothetical: on 2026-09-19 the reconciler re-created two August messages
-- from R2 (events `reconciled` at 09:07:26 and 09:09:24), and because reconcileInbound takes created_at from R2
-- metadata while minting a fresh row id, the restoration is invisible to any query that trusts created_at.
--
-- 'duplicate': a second R2 object holding bytes already indexed under another key. importResend wrote two objects per
-- message until 2026-09-20, leaving 57 of them. Retiring the queue row alone is not enough -- the object stays
-- unreferenced, so the next FULL sweep re-enqueues it and the drain re-retires it, weekly, for ever. Recording the
-- disposition is what ends that churn.
--
-- Recorded by KEY and, for a purge, also by IDENTITY, because either alone leaves a hole:
--  by key -- purge deletes messages.raw_key, so that object is named directly.
--  by identity -- a message may have had more than one object holding its bytes, and a copy purge never knew about is
--  indistinguishable from unindexed mail. Only (message_id, identity) recognises the MESSAGE rather
--  than one copy of it.
-- `direction` is carried so the identity arm can be restricted to inbound. purgeTrash tombstones every message in the
-- thread, including the user's own replies, and without this an inbound message reusing a purged OUTBOUND
-- Message-ID under the same account would be refused.
--
-- A message with NO raw_key AND no Message-ID cannot be tombstoned by either arm. That is harmless rather than a gap:
-- with no R2 object there is nothing for the sweep to find and nothing to resurrect.
--
-- NOTE for anyone editing this file: no inline "--" comment here may contain a semicolon. test/ingest.mjs applies these
-- migrations by splitting on ";" after dropping whole-line comments, so a semicolon inside a trailing comment silently
-- splits the statement and the table is never created -- which is exactly how this migration failed its first run.
CREATE TABLE IF NOT EXISTS purged_keys (
  raw_key    TEXT PRIMARY KEY,
  message_id TEXT,
  identity   TEXT,
  direction  TEXT,
  reason     TEXT NOT NULL DEFAULT 'purged',
  at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_purged_keys_ident ON purged_keys(message_id, identity);
