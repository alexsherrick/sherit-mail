-- R2-first ingest: the raw MIME is durable in R2 BEFORE any D1 read, so a D1 failure is a VISIBILITY outage, not
-- message loss. What that costs is a way to find the objects whose D1 projection never landed. Two layers, because
-- the fast one needs the database that may be the thing that is broken:
--  fast: a row written right after the R2 put; the cron drains it. Cheap, indexed, usually the only path used.
--  slow: a daily sweep comparing the month's R2 keys against messages.raw_key, which catches anything the fast
--  path could not record because D1 was unavailable at the time.
CREATE TABLE IF NOT EXISTS pending_ingest (
  raw_key    TEXT PRIMARY KEY,       -- R2 object holding the raw RFC822 bytes, content-addressed so a sender retry re-uses it
  rcpt       TEXT NOT NULL,
  env_from   TEXT,
  message_id TEXT,
  at         TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT
);
-- The drain asks "oldest rows not yet given up on": WHERE attempts < N ORDER BY at. An index on `at` alone cannot serve
-- that, so SQLite scanned the whole table every cron minute -- the same unbounded per-invocation scan we just removed
-- from the inbound path. Index both columns, in that order, so the predicate ranges and the sort comes out for free.
CREATE INDEX IF NOT EXISTS ix_pending_ingest_ready ON pending_ingest(attempts, at);
-- The slow sweep asks "is there a message row for this R2 key?". Without this index that question is a full scan of
-- messages, which is the same mistake as the per-message SUM(size_bytes) that was taken out.
CREATE INDEX IF NOT EXISTS ix_messages_raw_key ON messages(raw_key);
