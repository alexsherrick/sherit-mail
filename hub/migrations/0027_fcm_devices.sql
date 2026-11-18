-- Devices reached through Firebase Cloud Messaging: the native Android app,
-- built on FCM for the most reliable delivery. Web Push reaches browsers; FCM reaches the app, with
-- high-priority data messages that wake the phone so it can show the notification AND download the conversation before
-- the user opens it. One row per registration token; a token FCM reports as unregistered is deleted.
CREATE TABLE IF NOT EXISTS fcm_devices (
  token TEXT PRIMARY KEY,
  ua TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_ok_at TEXT,
  last_error TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0
);
