ALTER TABLE threads ADD COLUMN state TEXT NOT NULL DEFAULT 'inbox';
ALTER TABLE threads ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN labels TEXT;
ALTER TABLE messages ADD COLUMN labels TEXT;
CREATE INDEX IF NOT EXISTS ix_threads_state ON threads(state, last_message_at DESC);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  priority INTEGER NOT NULL DEFAULT 100,
  rcpt_glob TEXT NOT NULL,
  sender_glob TEXT NOT NULL DEFAULT '*',
  action TEXT NOT NULL CHECK (action IN ('forward','hold')),
  label TEXT,
  note TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
INSERT INTO rules (priority, rcpt_glob, sender_glob, action, label, note) VALUES
  (10, 'trademark@*', '*@uspto.gov', 'forward', 'USPTO', 'genuine USPTO correspondence: forward to Gmail, label'),
  (20, 'trademark@*', '*', 'hold', 'trademark-scam', 'everything else to the trademark correspondence addresses is a solicitation/scam: keep in the hub, no Gmail copy');
INSERT OR IGNORE INTO identities (email, display_name, domain, is_active) VALUES
  ('trademark@domain2.example', 'Sam Owner', 'domain2.example', 1),
  ('trademark@zone.test', 'Sam Owner', 'zone.test', 1);
UPDATE messages SET labels = '["USPTO"]' WHERE identity LIKE 'trademark@%' AND lower(from_addr) LIKE '%@uspto.gov';
UPDATE messages SET labels = '["trademark-scam"]', gmail_copy = 'held' WHERE identity LIKE 'trademark@%' AND lower(from_addr) NOT LIKE '%@uspto.gov';
UPDATE threads SET labels = (SELECT labels FROM messages m WHERE m.thread_id = threads.id AND m.labels IS NOT NULL ORDER BY m.created_at DESC LIMIT 1) WHERE id IN (SELECT thread_id FROM messages WHERE labels IS NOT NULL);
UPDATE threads SET unread = 1 WHERE last_message_at > datetime('now','-1 day') AND id IN (SELECT thread_id FROM messages WHERE direction='in');
