-- A sender's share of the day counts each picture at the size the hub keeps of it. A newsletter's four
-- PNGs (two of 2985 x 4096) were 13.8 MB as fetched and 0.71 MB once shrunk 23 seconds later, and the 15 MB share they had spent at full
-- size withheld its last two pictures for a day.
-- img_work.dom: the sending organisation whose share the picture spent (null: none, as for a picture an open kept).
ALTER TABLE img_work ADD COLUMN dom TEXT;
-- img_work.kept: the bytes kept once shrunk, both sizes and the original when it stays; the share gets back bytes - kept.
ALTER TABLE img_work ADD COLUMN kept INTEGER;
-- img_queue.size: a picture's bytes, once a fetch found it did not fit; it is not fetched again until it does.
ALTER TABLE img_queue ADD COLUMN size INTEGER;
