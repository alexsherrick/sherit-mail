-- A dismissal is only worth sending to a device that is actually holding the notification it dismisses.
-- Without this the Worker pushes blind: a device whose shade is already empty receives a dismiss that closes nothing, and
-- because a push handler may not finish with an empty shade
-- it would then have to show the "Inbox zero" placeholder for no reason at all. live_tags is the set of thread keys this
-- device has been shown a notification for and has not yet been told to drop: a JSON array of strings, pruned on write.
ALTER TABLE push_subscriptions ADD COLUMN live_tags TEXT;
