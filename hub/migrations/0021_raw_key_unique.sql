-- The projection deduplicates with SELECT-then-INSERT, which two concurrent deliveries can both pass before either
-- writes. message_id was already protected (ux_messages_msgid_dir, migration 0001) but a message with NO Message-ID is
-- not covered by that partial index, so the raw key has to carry the guarantee itself rather than a hopeful SELECT.
-- Verified safe against production before adding: 151 rows, 151 distinct raw_key, 0 nulls.
DROP INDEX IF EXISTS ix_messages_raw_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_raw_key ON messages(raw_key) WHERE raw_key IS NOT NULL;
