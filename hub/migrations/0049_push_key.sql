-- A per-phone key for push previews. FCM data messages pass through Google's servers readable: the sender, subject and
-- first 160 characters of each new mail, the domain mail kept off Gmail included. The Android app (1.13+) makes a 256-bit key and
-- registers it with its token; the hub then sends each push sealed with it (AES-256-GCM over the deflated JSON), so Google carries
-- ciphertext. NULL: an app that registered no key, which gets the sender only, never the subject or text.
ALTER TABLE fcm_devices ADD COLUMN push_key TEXT;
