-- Sign-in backoff for IMAP mailboxes. A mailbox whose server refuses the password was tried every minute by the
-- sync, again by the write-back queue and once per conversation by a bulk action: 202 refused sign-ins were logged in October 2026.
-- Mail hosts lock accounts out for that. The INBOX row of each mailbox now counts consecutive refusals and holds the time of the
-- next allowed try (ms since the epoch, like sync_until). A good sign-in or a new password clears both.
ALTER TABLE imap_folders ADD COLUMN auth_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE imap_folders ADD COLUMN auth_retry_at INTEGER;
