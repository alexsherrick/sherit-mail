ALTER TABLE messages ADD COLUMN gmail_copy TEXT;
UPDATE messages SET gmail_copy = CASE
  WHEN direction = 'out' THEN NULL
  WHEN ingest_source = 'cloudflare' AND gmail_forwarded_at IS NOT NULL THEN 'hub'
  WHEN ingest_source = 'cloudflare' THEN 'none'
  WHEN ingest_source = 'resend' AND (identity LIKE 'sam@%' OR (identity LIKE 'trademark@%' AND lower(from_addr) LIKE '%uspto.gov%')) THEN 'legacy'
  WHEN ingest_source = 'resend' THEN 'none'
  ELSE NULL END;
CREATE INDEX IF NOT EXISTS ix_messages_gmail_copy ON messages(gmail_copy);
