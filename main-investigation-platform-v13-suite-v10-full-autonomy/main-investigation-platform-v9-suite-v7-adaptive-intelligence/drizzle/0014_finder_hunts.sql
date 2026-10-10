-- 0014 · Site Finder hunts, as Site Finder reports them (additive).
-- A hunt is one bounded line of inquiry in Site Finder ("Looking for new deployments related to
-- Operation X", "Watching for x.com to reappear"). Main only displays them and uses them for
-- context; Site Finder remains the owner. One row per hunt, replaced on each report.
CREATE TABLE IF NOT EXISTS finder_hunts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  operation TEXT,
  found INTEGER NOT NULL DEFAULT 0,
  useful INTEGER NOT NULL DEFAULT 0,
  leads INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  open_pivots INTEGER NOT NULL DEFAULT 0,
  followed_pivots INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_finder_hunts_state ON finder_hunts(state, reported_at);
