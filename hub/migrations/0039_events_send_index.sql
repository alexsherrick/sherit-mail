-- Send idempotency lookups: `events` had only the time index, so finding a send's earlier attempt scanned every event
-- (13,257 rows for one of 34). Partial indexes hold only send events, so they cost a write only when one of those is logged.
-- Each WHERE matches its query's term exactly, which is what lets SQLite use a partial index (index.js lines with kind = 'send_idem' and
-- kind IN ('send_attempt','send_idem','send_sent','send_failed')).
CREATE INDEX IF NOT EXISTS ix_events_send_idem ON events(id) WHERE kind = 'send_idem';
CREATE INDEX IF NOT EXISTS ix_events_send ON events(id) WHERE kind IN ('send_attempt','send_idem','send_sent','send_failed');
