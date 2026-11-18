-- Security review 2026-11-13.
-- N2: each queued picture keeps its sender's organisation, so the minute cron's drain spends that sender's share of the day as an arrival
-- does (the drain checked only the day's allowance, and one sender took the whole 250 MB through it).
ALTER TABLE img_queue ADD COLUMN dom TEXT;
-- N3: each blocked picture keeps its pattern, so the user's Undo finds its rows directly (it read the newest 5,000 and filtered them,
-- and 26 small flood mails pushed the real ones out of reach).
ALTER TABLE trk_verdict ADD COLUMN pat TEXT;
CREATE INDEX IF NOT EXISTS ix_trk_verdict_pat ON trk_verdict(pat);
