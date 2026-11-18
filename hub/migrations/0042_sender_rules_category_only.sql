-- A sender rule may hold a category and no action. Filing a sender under a category used to store
-- action = 'accept', and an address-level accept outranks a domain-level block, so every sender an unsubscribe filed under Newsletters
-- escaped a later block of its whole domain. SQLite cannot drop a NOT NULL in place, so the table is rebuilt: same columns, same index,
-- action now NULL or one of the three. The address-level accepts that carry a category become NULL. A deliberate address accept
-- exists too (the screener's exception to a domain block, the Settings form), so the live table was read first: 104 such
-- rows, every one a marketing sender filed by an unsubscribe or a category; none under a domain block (the one is *@scam.example);
-- no accept without a category anywhere in the event log since it begins. A deliberate accept with no category is untouched.
-- Run remotely as one file, which D1 applies in full or not at all.
CREATE TABLE sender_rules_new (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,            -- exact address or *@domain, lowercase
  action TEXT CHECK (action IS NULL OR action IN ('block','accept','priority')),   -- NULL: the rule only files a category
  scope TEXT NOT NULL DEFAULT '*',  -- '*' or an account
  created_at TEXT NOT NULL,
  category TEXT                     -- personal | notifications | newsletters
);
INSERT INTO sender_rules_new (id, pattern, action, scope, created_at, category)
  SELECT id, pattern, CASE WHEN action = 'accept' AND category IS NOT NULL AND pattern NOT LIKE '*@%' THEN NULL ELSE action END, scope, created_at, category FROM sender_rules;
DROP TABLE sender_rules;
ALTER TABLE sender_rules_new RENAME TO sender_rules;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sender_rules ON sender_rules(pattern, scope);
