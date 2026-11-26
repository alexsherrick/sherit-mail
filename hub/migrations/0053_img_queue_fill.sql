-- A picture queued to catch up old mail (the Gmail mirror's picture fill, or a backfill run by hand) is marked, so the
-- minute cron's drain fetches it only while the day's allowance and its sender's share are both more than half left, and after any
-- picture new mail is waiting for. A backfill spent google.com's whole 15 MB share in four minutes on 2026-11-24, and the next
-- morning's Google mail had 8 of its pictures withheld until that spending was 24 hours old.
ALTER TABLE img_queue ADD COLUMN fill INTEGER NOT NULL DEFAULT 0;
