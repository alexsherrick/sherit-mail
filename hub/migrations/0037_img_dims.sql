-- Picture sizes: the width and height of each picture the hub keeps, read from its header when it is stored. The app
-- syncs them and gives each picture its box before the picture arrives, so an opened mail does not grow in steps.
-- hk: a 53-bit hash of the URL as /api/img keys it (urlHash(new URL(u).href)), the same function in index.js and client/app.js.
-- seq orders the rows for the app's sync (GET /api/imgdims?since=seq); at bounds a first sync to the last two weeks.
CREATE TABLE IF NOT EXISTS img_dims (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  hk INTEGER NOT NULL UNIQUE,
  w INTEGER NOT NULL,
  h INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_img_dims_at ON img_dims(at);
