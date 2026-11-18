-- Smart Inbox categories for hub mail (personal | notifications | newsletters), computed at ingest from headers; used by the
-- client, the CLI and the Worker's notification policy. Gmail categories are computed in the client from Gmail's labels/headers.
ALTER TABLE messages ADD COLUMN category TEXT;
ALTER TABLE threads ADD COLUMN category TEXT;
CREATE INDEX IF NOT EXISTS ix_threads_category ON threads(category, state);
