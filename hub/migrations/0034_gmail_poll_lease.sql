-- One Gmail poll per mailbox at a time. Pub/Sub delivers a burst of notifications for a burst of
-- changes, each starts a poll of the same mailbox, and the cron's ten-minute backstop can land on top: two runs fetched the same
-- history and metadata and ran the sender rules twice (gmail_poll_dup up to 11 a day). A run holds the lease while it polls; one
-- that finds it held sets poll_again, and the holder polls once more before it lets go, so no change waits for the next backstop.
ALTER TABLE gmail_accounts ADD COLUMN poll_lease_until INTEGER;
ALTER TABLE gmail_accounts ADD COLUMN poll_lease_token TEXT;
ALTER TABLE gmail_accounts ADD COLUMN poll_again INTEGER NOT NULL DEFAULT 0;
