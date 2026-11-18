-- What the Worker told the devices, kept for a few days so a client WITHOUT Web Push can still be told.
--
-- The native Mac app (started 2026-10-02) shows the web client inside Apple's WKWebView, and
-- Apple supports Web Push only in Safari and Safari web apps, never in WKWebView. So the app asks the hub instead: every
-- notification sendPush() raises, and every dismissal sendDismissPush() sends, is also written here once (not once per
-- device), and the app reads everything after its cursor. Rows older than three days are deleted on insert.
CREATE TABLE IF NOT EXISTS notify_feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notify_feed_at ON notify_feed(at);
