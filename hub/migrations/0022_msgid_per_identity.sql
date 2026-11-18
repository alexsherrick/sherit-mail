-- ux_messages_msgid_dir was UNIQUE on (message_id, direction) across the WHOLE hub, so the same message addressed to two
-- of the user's six domains could only ever be stored once: the second delivery was accepted, deduplicated away, and
-- never appeared for that recipient. The projection's dedup was still recipient-global after the
-- forward precheck had been scoped; scoping the SELECT alone would not have helped,
-- because this index would still have refused the row. Uniqueness is per recipient.
-- Verified safe against production first: 0 message-ids currently span more than one identity.
DROP INDEX IF EXISTS ux_messages_msgid_dir;
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_msgid_dir_ident ON messages(message_id, direction, identity) WHERE message_id IS NOT NULL;
