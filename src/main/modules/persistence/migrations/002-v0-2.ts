/**
 * v0.2: dynamic graph revisions, consensus planning, model routing, task outcomes, repository facts and
 * context packs. Purely additive: no v0.1 table is altered. task_id/agent_id columns are plain text (no
 * foreign key), like run_events, so history survives task deletion during replanning.
 */
export const v02Schema = /* sql */ `
CREATE TABLE graph_revisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  proposal_id TEXT,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, version)
);

CREATE TABLE graph_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  proposed_by_agent_id TEXT,
  proposed_by TEXT NOT NULL,
  task_id TEXT,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  changes TEXT NOT NULL,
  status TEXT NOT NULL,
  rejection_reason TEXT,
  revision_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_graph_proposals_run ON graph_proposals(run_id, created_at);
CREATE INDEX idx_graph_proposals_status ON graph_proposals(run_id, status);

CREATE TABLE planning_candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  lens TEXT NOT NULL,
  agent_id TEXT,
  plan TEXT,
  valid INTEGER NOT NULL,
  errors TEXT NOT NULL,
  duration_ms INTEGER,
  model TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_planning_candidates_run ON planning_candidates(run_id, created_at);

CREATE TABLE planning_critiques (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT,
  output TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_planning_critiques_run ON planning_critiques(run_id, created_at);

CREATE TABLE routing_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  requested_policy TEXT NOT NULL,
  resolved_policy TEXT NOT NULL,
  resolved_tier TEXT,
  resolved_model TEXT,
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_routing_run ON routing_decisions(run_id, created_at);
CREATE INDEX idx_routing_task ON routing_decisions(task_id, created_at) WHERE task_id IS NOT NULL;
CREATE INDEX idx_routing_agent ON routing_decisions(agent_id, created_at) WHERE agent_id IS NOT NULL;

CREATE TABLE task_outcomes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  model TEXT,
  tier TEXT,
  category TEXT NOT NULL,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  first_pass_verified INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  review_rejections INTEGER NOT NULL,
  repair_count INTEGER NOT NULL,
  checks_failed INTEGER NOT NULL,
  human_interventions INTEGER NOT NULL,
  elapsed_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_outcomes_project ON task_outcomes(project_id, created_at);
CREATE INDEX idx_outcomes_run ON task_outcomes(run_id);
CREATE INDEX idx_outcomes_group ON task_outcomes(role, model, category);

-- seq is an explicit INTEGER PRIMARY KEY so the FTS index keeps pointing at the right row across VACUUM.
CREATE TABLE repository_facts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  statement TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  files TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  UNIQUE (project_id, kind, subject)
);
CREATE INDEX idx_facts_project ON repository_facts(project_id, stale);

CREATE VIRTUAL TABLE repository_facts_fts USING fts5(
  subject, statement, files,
  content='repository_facts', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER repository_facts_ai AFTER INSERT ON repository_facts BEGIN
  INSERT INTO repository_facts_fts(rowid, subject, statement, files)
  VALUES (new.seq, new.subject, new.statement, new.files);
END;
CREATE TRIGGER repository_facts_ad AFTER DELETE ON repository_facts BEGIN
  INSERT INTO repository_facts_fts(repository_facts_fts, rowid, subject, statement, files)
  VALUES ('delete', old.seq, old.subject, old.statement, old.files);
END;
CREATE TRIGGER repository_facts_au AFTER UPDATE ON repository_facts BEGIN
  INSERT INTO repository_facts_fts(repository_facts_fts, rowid, subject, statement, files)
  VALUES ('delete', old.seq, old.subject, old.statement, old.files);
  INSERT INTO repository_facts_fts(rowid, subject, statement, files)
  VALUES (new.seq, new.subject, new.statement, new.files);
END;

CREATE TABLE context_packs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  purpose TEXT NOT NULL,
  total_chars INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_context_packs_run ON context_packs(run_id, created_at);
CREATE INDEX idx_context_packs_task ON context_packs(task_id, created_at) WHERE task_id IS NOT NULL;
CREATE INDEX idx_context_packs_agent ON context_packs(agent_id, created_at) WHERE agent_id IS NOT NULL;

CREATE TABLE context_pack_entries (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES context_packs(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  included INTEGER NOT NULL,
  chars INTEGER NOT NULL
);
CREATE INDEX idx_context_entries_pack ON context_pack_entries(pack_id);
`
