-- What each Android device is showing, so a dismissal can wake it only where it removes something on screen.
-- live_tags: keys of mail the hub pushed HIGH to this device and has not yet dismissed or heard was swiped away.
-- pend_tags: keys that WERE live when their dismissal had to go NORMAL (Doze may hold it for hours): the next HIGH mail push carries them.
-- demoted_at: the last time the app saw Firebase deliver one of our HIGH messages at NORMAL. For 7 days after it (FCM's own judging
-- window) dismissals go NORMAL, so a dismissal can never be what slows new mail down.
ALTER TABLE fcm_devices ADD COLUMN live_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fcm_devices ADD COLUMN pend_tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fcm_devices ADD COLUMN demoted_at TEXT;
