ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;        -- raw List-Unsubscribe header (mailto: and/or https:)
ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;   -- "List-Unsubscribe=One-Click" when RFC 8058 applies
