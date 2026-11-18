-- "Real or fake". The receiving server's own sender verdict for domain mail: the first Authentication-Results that
-- mx.cloudflare.net stamped, kept as the raw header so the client parses it with the same code it uses for Gmail. And the
-- registration dates of domains a brand alarm pointed at, asked of RDAP once and kept, so the banner can say how new a link is.
ALTER TABLE messages ADD COLUMN auth_results TEXT;
CREATE TABLE IF NOT EXISTS domain_ages (
  domain TEXT PRIMARY KEY,
  registered TEXT,
  checked_at TEXT NOT NULL
);
