// Schema v1. Timestamps are ISO-8601 strings, booleans are 0/1, arrays/objects are JSON text.
export const initialSchema = /* sql */ `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  profile TEXT,
  respect_project_claude_config INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  preset TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  pause_reason TEXT,
  prompt TEXT NOT NULL,
  plan TEXT,
  base_branch TEXT,
  base_commit TEXT,
  integration_branch TEXT,
  config TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_runs_project ON runs(project_id, created_at);
CREATE INDEX idx_runs_state ON runs(state);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  "key" TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  parallelizable INTEGER NOT NULL,
  requires_approval INTEGER NOT NULL,
  approval_granted INTEGER NOT NULL,
  suggested_files TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  repair_cycles INTEGER NOT NULL DEFAULT 0,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  model_tier_override TEXT,
  branch TEXT,
  worktree_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  result_summary TEXT,
  blocked_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (run_id, "key")
);
CREATE INDEX idx_tasks_run_state ON tasks(run_id, state);
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE lease_expires_at IS NOT NULL;
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX idx_task_deps_reverse ON task_dependencies(depends_on_task_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  model TEXT,
  activity TEXT,
  metrics TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT
);
CREATE INDEX idx_agents_run ON agents(run_id, state);
CREATE INDEX idx_agents_task ON agents(task_id);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sdk_session_id TEXT,
  model TEXT,
  state TEXT NOT NULL,
  end_reason TEXT,
  handoff TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_sessions_agent ON agent_sessions(agent_id, started_at);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT,
  from_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  from_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  from_label TEXT NOT NULL,
  to_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  to_role TEXT,
  to_label TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_messages_run ON agent_messages(run_id, created_at);

CREATE TABLE message_recipients (
  message_id TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  delivered_at TEXT,
  PRIMARY KEY (message_id, task_id)
);
CREATE INDEX idx_recipients_pending ON message_recipients(task_id) WHERE delivered_at IS NULL;

CREATE TABLE agent_output (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, seq)
);

CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_run ON run_events(run_id, seq);
CREATE INDEX idx_events_task ON run_events(task_id, seq) WHERE task_id IS NOT NULL;

CREATE TABLE tool_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  output_preview TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_tool_events_agent ON tool_events(agent_id, started_at);
CREATE INDEX idx_tool_events_use ON tool_events(tool_use_id);
CREATE INDEX idx_tool_events_run ON tool_events(run_id);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_worktrees_run ON worktrees(run_id, state);
CREATE INDEX idx_worktrees_task ON worktrees(task_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_task ON reviews(task_id, created_at);
CREATE INDEX idx_reviews_run ON reviews(run_id);

CREATE TABLE verification_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  passed INTEGER NOT NULL,
  summary TEXT NOT NULL,
  criteria TEXT NOT NULL,
  commands TEXT NOT NULL,
  failures TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_verifications_task ON verification_results(task_id, created_at);
CREATE INDEX idx_verifications_run ON verification_results(run_id);

CREATE TABLE acceptance_criteria (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_criteria_run ON acceptance_criteria(run_id);
CREATE INDEX idx_criteria_task ON acceptance_criteria(task_id);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_run ON decisions(run_id, created_at);

-- seq is an explicit INTEGER PRIMARY KEY so the FTS index keeps pointing at the right row across VACUUM.
CREATE TABLE memory (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL,
  file_paths TEXT NOT NULL,
  source TEXT NOT NULL,
  evidence TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_project ON memory(project_id, status);
CREATE INDEX idx_memory_scope ON memory(scope, status);
CREATE INDEX idx_memory_run ON memory(run_id);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, content, tags, file_paths,
  content='memory', content_rowid='seq', tokenize='porter unicode61'
);
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, content, tags, file_paths)
  VALUES (new.seq, new.title, new.content, new.tags, new.file_paths);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags, file_paths)
  VALUES ('delete', old.seq, old.title, old.content, old.tags, old.file_paths);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, content, tags, file_paths)
  VALUES ('delete', old.seq, old.title, old.content, old.tags, old.file_paths);
  INSERT INTO memory_fts(rowid, title, content, tags, file_paths)
  VALUES (new.seq, new.title, new.content, new.tags, new.file_paths);
END;

CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  command TEXT,
  requested_by TEXT NOT NULL,
  risk TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_approvals_run ON approval_requests(run_id, created_at);
CREATE INDEX idx_approvals_pending ON approval_requests(status) WHERE status = 'pending';

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id, created_at);

CREATE TABLE usage_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  context_window INTEGER,
  turns INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_run ON usage_snapshots(run_id, created_at);
CREATE INDEX idx_usage_agent ON usage_snapshots(agent_id, created_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`
