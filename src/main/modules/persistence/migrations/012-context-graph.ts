/**
 * 0.7.1: the Context Graph and token accounting. Additive only: no existing table changes, so a database
 * of 0.7.0 upgrades by gaining empty tables. The graph tables are an index over the existing stores and can
 * be dropped and rebuilt without losing knowledge.
 */
export const contextGraphSchema = `
-- seq is an explicit INTEGER PRIMARY KEY so the FTS index keeps pointing at the right row across VACUUM.
CREATE TABLE context_nodes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  space_kind TEXT NOT NULL,
  space_id TEXT NOT NULL,
  program_id TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  origin_kind TEXT NOT NULL,
  origin_id TEXT,
  trust TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence TEXT NOT NULL,
  subject_key TEXT,
  content_hash TEXT NOT NULL,
  summary_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'normal',
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_updated_at TEXT,
  refreshed_at TEXT,
  UNIQUE (space_kind, space_id, path)
);
CREATE INDEX idx_context_nodes_parent ON context_nodes(parent_id, type, title);
CREATE INDEX idx_context_nodes_space_status ON context_nodes(space_kind, space_id, status, type);
CREATE INDEX idx_context_nodes_origin ON context_nodes(origin_kind, origin_id);
CREATE INDEX idx_context_nodes_subject ON context_nodes(space_kind, space_id, subject_key) WHERE subject_key IS NOT NULL;
CREATE INDEX idx_context_nodes_program ON context_nodes(program_id) WHERE program_id IS NOT NULL;

CREATE VIRTUAL TABLE context_nodes_fts USING fts5(
  title, summary, path,
  content='context_nodes', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER context_nodes_ai AFTER INSERT ON context_nodes BEGIN
  INSERT INTO context_nodes_fts(rowid, title, summary, path) VALUES (new.seq, new.title, new.summary, new.path);
END;
CREATE TRIGGER context_nodes_ad AFTER DELETE ON context_nodes BEGIN
  INSERT INTO context_nodes_fts(context_nodes_fts, rowid, title, summary, path) VALUES ('delete', old.seq, old.title, old.summary, old.path);
END;
CREATE TRIGGER context_nodes_au AFTER UPDATE OF title, summary, path ON context_nodes BEGIN
  INSERT INTO context_nodes_fts(context_nodes_fts, rowid, title, summary, path) VALUES ('delete', old.seq, old.title, old.summary, old.path);
  INSERT INTO context_nodes_fts(rowid, title, summary, path) VALUES (new.seq, new.title, new.summary, new.path);
END;

CREATE TABLE context_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  trust TEXT NOT NULL,
  confidence TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (from_id, to_id, type)
);
CREATE INDEX idx_context_edges_from ON context_edges(from_id, type);
CREATE INDEX idx_context_edges_to ON context_edges(to_id, type);

CREATE TABLE context_node_sources (
  node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  hash TEXT,
  PRIMARY KEY (node_id, kind, ref)
);
CREATE INDEX idx_context_sources_ref ON context_node_sources(space_id, kind, ref);

CREATE TABLE context_node_versions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  trust TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (node_id, version)
);

CREATE TABLE context_node_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  node_id TEXT NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_context_history_node ON context_node_history(node_id, seq);

CREATE TABLE context_refresh_jobs (
  id TEXT PRIMARY KEY,
  space_kind TEXT NOT NULL,
  space_id TEXT NOT NULL,
  "trigger" TEXT NOT NULL,
  from_commit TEXT,
  to_commit TEXT,
  changed_files INTEGER NOT NULL DEFAULT 0,
  nodes_checked INTEGER NOT NULL DEFAULT 0,
  nodes_stale INTEGER NOT NULL DEFAULT 0,
  nodes_refreshed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX idx_context_refresh_space ON context_refresh_jobs(space_kind, space_id, finished_at);

-- ───────────── token accounting ─────────────

CREATE TABLE prompt_components (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  priority INTEGER NOT NULL,
  hash TEXT NOT NULL,
  chars INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  cacheability TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (key, hash)
);

CREATE TABLE prompt_prefixes (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  components TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  role TEXT NOT NULL,
  tool_set_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  cacheable INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_cache_result TEXT,
  last_cache_read_tokens INTEGER,
  last_cache_write_tokens INTEGER
);

CREATE TABLE token_request_breakdowns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  sdk_session_id TEXT,
  basis TEXT NOT NULL,
  model TEXT,
  total_tokens INTEGER NOT NULL,
  max_tokens INTEGER,
  components TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_token_breakdowns_run ON token_request_breakdowns(run_id, created_at);
CREATE INDEX idx_token_breakdowns_agent ON token_request_breakdowns(agent_id, created_at) WHERE agent_id IS NOT NULL;

CREATE TABLE cache_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  sdk_session_id TEXT,
  request_index INTEGER NOT NULL,
  prefix_hash TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  role TEXT,
  input_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  result TEXT NOT NULL,
  expected_warm INTEGER NOT NULL DEFAULT 0,
  cause TEXT,
  cause_basis TEXT,
  reuse_distance_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cache_events_run ON cache_events(run_id, created_at);
CREATE INDEX idx_cache_events_agent ON cache_events(agent_id, request_index) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_cache_events_prefix ON cache_events(prefix_hash, created_at) WHERE prefix_hash IS NOT NULL;
CREATE INDEX idx_cache_events_created ON cache_events(created_at);

CREATE TABLE context_optimization_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  token_effect INTEGER,
  basis TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_context_decisions_run ON context_optimization_decisions(run_id, created_at);
CREATE INDEX idx_context_decisions_agent ON context_optimization_decisions(agent_id, created_at) WHERE agent_id IS NOT NULL;

CREATE TABLE artifact_context_refs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  chars_total INTEGER NOT NULL,
  chars_shown INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifact_context_refs_run ON artifact_context_refs(run_id, created_at);
CREATE INDEX idx_artifact_context_refs_task ON artifact_context_refs(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE compaction_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  sdk_session_id TEXT,
  "trigger" TEXT NOT NULL,
  pre_tokens INTEGER,
  post_tokens INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_compaction_events_run ON compaction_events(run_id, created_at);

CREATE TABLE session_efficiency (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  sdk_session_id TEXT,
  turns INTEGER NOT NULL,
  context_tokens INTEGER,
  max_tokens INTEGER,
  output_tokens INTEGER,
  thinking_tokens INTEGER,
  pressure TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_session_efficiency_run ON session_efficiency(run_id, created_at);
CREATE INDEX idx_session_efficiency_agent ON session_efficiency(agent_id, created_at) WHERE agent_id IS NOT NULL;

CREATE TABLE token_benchmark_results (
  id TEXT PRIMARY KEY,
  benchmark TEXT NOT NULL,
  variant TEXT NOT NULL,
  case_key TEXT NOT NULL,
  metrics TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_token_benchmark ON token_benchmark_results(benchmark, variant, created_at);
`
