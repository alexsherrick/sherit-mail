-- The Unsubscribes list and its backstop (slices 2 and 3). A sender the hub unsubscribed from that mails again after the
-- FTC's 10 business days is noted on its job (still_*), and the user's answer to a row ("done" on one that needed the page, "keep"
-- on a sender still mailing) takes it off the "needs you" count (dismissed_at). Arrivals look the job up by sender.
ALTER TABLE unsubscribes ADD COLUMN still_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE unsubscribes ADD COLUMN still_at TEXT;
ALTER TABLE unsubscribes ADD COLUMN still_subject TEXT;
ALTER TABLE unsubscribes ADD COLUMN still_ref TEXT;           -- the last arrival counted, by its message id: two runs that see it count it once
ALTER TABLE unsubscribes ADD COLUMN dismissed_at TEXT;
CREATE INDEX IF NOT EXISTS ix_unsubscribes_sender ON unsubscribes(sender);
