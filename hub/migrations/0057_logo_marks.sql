-- Logo fingerprints: the protected brands' logo variants and every kept sender logo, for the copied-logo check
-- (index.js logoCopyOf). `ph`: a 63-bit perceptual hash (16 hex digits); `sig`: a 4 x 4 grid of mean colours (96 hex digits); `sd`: the
-- grey grid's spread (flat pictures are not kept); `src`: "brand" (logoCorpusTick) or "kept" (ensureLogo).
CREATE TABLE IF NOT EXISTS logo_marks (
  org TEXT NOT NULL,
  ph TEXT NOT NULL,
  sig TEXT NOT NULL,
  sd REAL NOT NULL,
  src TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (org, ph)
);
