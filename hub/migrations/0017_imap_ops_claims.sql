-- A per-row claim for imap_ops, so two concurrent cron invocations cannot apply the same op twice.
-- Cron overlap is not hypothetical here: it was PROVED on 2026-09-11 (two Gmail polls of one account a second apart, R30), and
-- scheduled_actions has claimed its rows since 0010 for exactly this reason. imap_ops was the remaining unclaimed queue.
-- Two concurrent invocations can SELECT and apply
-- the same pending rows, satisfying the 'applied twice' failure mode."
ALTER TABLE imap_ops ADD COLUMN claimed_at TEXT;
CREATE INDEX IF NOT EXISTS ix_imap_ops_claimed ON imap_ops(status, claimed_at);
