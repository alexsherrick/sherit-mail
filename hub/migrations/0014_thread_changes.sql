-- One ordered change feed for threads, replacing the millisecond `updated_at` cursor and the tombstone table:
-- a timestamp cursor cannot separate two writes inside the same millisecond, and tombstones paged on their own cursor could be skipped.
-- rowid/AUTOINCREMENT gives a strictly increasing seq, so a client cursor is exact. Written by triggers, so no call site can miss one.
DROP TRIGGER IF EXISTS threads_tombstone;
DROP TABLE IF EXISTS deleted_threads;
CREATE TABLE IF NOT EXISTS thread_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  op TEXT NOT NULL,                 -- u = the row exists and changed (insert or update), d = the row is gone
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_thread_changes_at ON thread_changes(at);
CREATE TRIGGER IF NOT EXISTS thread_changes_ins AFTER INSERT ON threads FOR EACH ROW
BEGIN INSERT INTO thread_changes (thread_id, op, at) VALUES (NEW.id, 'u', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER IF NOT EXISTS thread_changes_upd AFTER UPDATE ON threads FOR EACH ROW
BEGIN INSERT INTO thread_changes (thread_id, op, at) VALUES (NEW.id, 'u', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
CREATE TRIGGER IF NOT EXISTS thread_changes_del AFTER DELETE ON threads FOR EACH ROW
BEGIN INSERT INTO thread_changes (thread_id, op, at) VALUES (OLD.id, 'd', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
