/**
 * 0.8: Internet research. Purely additive. A research artifact records one text read on the public web: where
 * it came from, when, what kind of source that is, its hash, and how the screening found it. The text itself
 * is a file beside the database (`text_path`), not a column: a prompt gets a passage and a reference, never
 * the page. A download is a file held in quarantine with what is known of it; it runs nowhere because it is here.
 */
export const researchSchema = /* sql */ `
CREATE TABLE research_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  task_id TEXT,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  redirect_chain TEXT NOT NULL,
  title TEXT,
  retrieved_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_type TEXT,
  bytes INTEGER NOT NULL,
  backend TEXT NOT NULL,
  source_type TEXT NOT NULL,
  authority TEXT NOT NULL,
  publisher TEXT NOT NULL,
  freshness TEXT NOT NULL,
  stale_after TEXT NOT NULL,
  trust TEXT NOT NULL CHECK(trust = 'UNTRUSTED_WEB_CONTENT'),
  screening TEXT NOT NULL,
  summary TEXT NOT NULL,
  text_chars INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  query TEXT,
  text_path TEXT
);
CREATE INDEX idx_research_artifacts_url ON research_artifacts(project_id, canonical_url, retrieved_at);
CREATE INDEX idx_research_artifacts_run ON research_artifacts(run_id, retrieved_at);
CREATE INDEX idx_research_artifacts_task ON research_artifacts(task_id, retrieved_at);

CREATE TABLE research_downloads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  task_id TEXT,
  url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT,
  sniffed TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  suggested_name TEXT,
  downloaded_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('QUARANTINED','REFUSED','RELEASED','REMOVED')),
  refusal TEXT,
  quarantine_path TEXT
);
CREATE INDEX idx_research_downloads_run ON research_downloads(run_id, downloaded_at);
`
