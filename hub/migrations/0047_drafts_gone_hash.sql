-- Drafts: a tombstone keeps the SHA-256 of the content it replaced, so a
-- device whose stale copy is exactly what was sent drops it, and a device holding newer text keeps that as a new draft, instead of
-- either one bringing the sent message back under its id.
ALTER TABLE drafts ADD COLUMN gone_hash TEXT;
