-- Gmail push (Cloud Pub/Sub): when a mailbox has a live watch the minute poll steps back to a ten-minute backstop, so the Worker needs
-- to know the watch's expiry, and the daily job needs somewhere to record the renewal. last_push_at is for the daily report only.
ALTER TABLE gmail_accounts ADD COLUMN watch_expiration TEXT;
ALTER TABLE gmail_accounts ADD COLUMN last_push_at TEXT;
