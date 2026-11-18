-- D1 runs triggers recursively: the inner UPDATE that threads_touch uses to set updated_at fired thread_changes_upd a second time, so
-- one real change wrote two events. The same guard threads_touch uses tells the two apart: on the caller's own UPDATE the stamp has
-- not moved yet, on the trigger's inner UPDATE it has.
DROP TRIGGER IF EXISTS thread_changes_upd;
CREATE TRIGGER thread_changes_upd AFTER UPDATE ON threads FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
BEGIN INSERT INTO thread_changes (thread_id, op, at) VALUES (NEW.id, 'u', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')); END;
DELETE FROM thread_changes;
