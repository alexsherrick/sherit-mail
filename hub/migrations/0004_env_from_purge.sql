ALTER TABLE messages ADD COLUMN env_from TEXT;
CREATE INDEX IF NOT EXISTS ix_messages_env_from ON messages(env_from, created_at);
CREATE INDEX IF NOT EXISTS ix_messages_from_created ON messages(from_addr, created_at);
