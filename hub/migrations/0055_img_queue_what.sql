-- A mail's own fonts are kept like its pictures, fetched when it arrives. img_queue.what says what a row fetches:
-- NULL a picture, 'font' a font file (kept by its bytes: WOFF2, WOFF, OpenType, TrueType or a collection), 'css' a stylesheet the mail
-- links or imports, kept as its usable @font-face rules alone.
ALTER TABLE img_queue ADD COLUMN what TEXT;
