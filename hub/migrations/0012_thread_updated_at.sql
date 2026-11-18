-- A per-thread change stamp so the client can ask for what changed instead of mirroring the whole store every minute.
-- Maintained by a trigger, not by call sites: there are thirteen places that UPDATE threads and a missed one would hide a change
-- from the other devices until the next full reconcile. `%f` gives milliseconds, matching the Worker's new Date().toISOString(),
-- so string comparison against a client cursor is correct.
ALTER TABLE threads ADD COLUMN updated_at TEXT;
UPDATE threads SET updated_at = COALESCE(last_message_at, created_at, '1970-01-01T00:00:00.000Z') WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_threads_updated ON threads(updated_at);
CREATE TRIGGER IF NOT EXISTS threads_touch AFTER UPDATE ON threads FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN UPDATE threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS threads_touch_ins AFTER INSERT ON threads FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN UPDATE threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
