-- One sync per mailbox at a time. The first full sync of the user's work inbox took ~65 s, the cron starts a sync
-- every minute, and progress was saved only at the end: overlapping runs stored the same message twice, the second hit the
-- (message_id, direction, identity) unique index and aborted, nothing was saved, and every run started over. A run now holds a lease
-- (sync_until, epoch ms; sync_token, the holder) renewed after each batch, and saves its progress as it goes.
ALTER TABLE imap_folders ADD COLUMN sync_until INTEGER;
ALTER TABLE imap_folders ADD COLUMN sync_token TEXT;
