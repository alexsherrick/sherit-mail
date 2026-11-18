-- A dedicated dismiss push shows NOTHING, which is only safe on a service worker that also carries the
-- never-empty-shade rule (ensureVisible). A device still running the worker deployed before that rule would finish the handler
-- with an empty shade and spend Chromium push budget: the exact failure this design exists to make impossible. So the client
-- now declares what it can do when it registers, and the Worker sends dismiss pushes only to a device that claims `dismiss2`.
-- Anything else falls back to the piggyback, which is what it had before. A capability LIST, not a version: the build id is a
-- content hash and cannot be compared for order.
ALTER TABLE push_subscriptions ADD COLUMN caps TEXT;
