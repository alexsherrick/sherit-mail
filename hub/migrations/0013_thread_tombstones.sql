-- Purged threads leave a tombstone so an incremental sync can remove them on every device. A trigger, not the two call sites, so a
-- future delete path cannot forget one. Pruned with the events log (30 days), which is far longer than any client's sync gap.
CREATE TABLE IF NOT EXISTS deleted_threads (id TEXT PRIMARY KEY, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_deleted_threads_at ON deleted_threads(at);
CREATE TRIGGER IF NOT EXISTS threads_tombstone AFTER DELETE ON threads FOR EACH ROW
BEGIN INSERT OR REPLACE INTO deleted_threads (id, at) VALUES (OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
