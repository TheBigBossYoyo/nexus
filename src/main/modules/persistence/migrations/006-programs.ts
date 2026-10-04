/**
 * v0.4: Programs. Purely additive: no earlier table is altered. A program owns milestones, workstreams,
 * missions (links to ordinary runs), a decision trail, checkpoints, plan revisions and validated memory.
 * Backlog items, expertise profiles and background jobs belong to a project and outlive a program.
 */
export const programsSchema = /* sql */ `
CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  pause_reason TEXT,
  blocked_reason TEXT,
  policy TEXT NOT NULL,
  schedule TEXT,
  plan_version INTEGER NOT NULL DEFAULT 0,
  branch TEXT,
  base_commit TEXT,
  current_milestone_id TEXT,
  current_run_id TEXT,
  current_run_kind TEXT,
  active_ms INTEGER NOT NULL DEFAULT 0,
  active_since TEXT,
  quota_wait_since TEXT,
  missions INTEGER NOT NULL DEFAULT 0,
  replans INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_programs_project ON programs(project_id, created_at);
CREATE INDEX idx_programs_state ON programs(state);

CREATE TABLE program_workstreams (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  expertise TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (program_id, key)
);

CREATE TABLE program_milestones (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  workstream_id TEXT,
  expertise TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  gaps TEXT NOT NULL,
  evidence TEXT,
  blocked_reason TEXT,
  plan_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (program_id, key)
);
CREATE INDEX idx_program_milestones_program ON program_milestones(program_id, ordinal);

CREATE TABLE program_missions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  strategy TEXT,
  outcome TEXT NOT NULL,
  base_commit TEXT,
  result_commit TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_program_missions_program ON program_missions(program_id, created_at);
CREATE INDEX idx_program_missions_run ON program_missions(run_id);

CREATE TABLE program_decisions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  milestone_id TEXT,
  run_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_program_decisions_program ON program_decisions(program_id, created_at);

CREATE TABLE program_checkpoints (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_program_checkpoints_program ON program_checkpoints(program_id, created_at);

CREATE TABLE program_plan_revisions (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  reason TEXT NOT NULL,
  milestones TEXT NOT NULL,
  deferred TEXT NOT NULL,
  diff TEXT NOT NULL,
  strategy_note TEXT,
  status TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_program_plan_revisions_program ON program_plan_revisions(program_id, version);

CREATE TABLE program_memory (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  milestone_key TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT NOT NULL,
  tags TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_program_memory_program ON program_memory(program_id, status, created_at);

CREATE TABLE backlog_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  program_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence TEXT NOT NULL,
  complexity TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  recommended_milestone TEXT,
  provenance TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_backlog_items_project ON backlog_items(project_id, status, created_at);
CREATE INDEX idx_backlog_items_program ON backlog_items(program_id, status);

CREATE TABLE expertise_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  area TEXT NOT NULL,
  project_areas TEXT NOT NULL,
  milestones_accepted INTEGER NOT NULL DEFAULT 0,
  milestones_rejected INTEGER NOT NULL DEFAULT 0,
  missions INTEGER NOT NULL DEFAULT 0,
  memory_ids TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, area)
);

CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT,
  proposals INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_background_jobs_project ON background_jobs(project_id, created_at);
`
