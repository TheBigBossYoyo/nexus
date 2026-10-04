/**
 * v0.5: Workspaces. Purely additive. A workspace groups enrolled repositories (each one an existing project),
 * the dependencies between them, their contracts and contract versions, cross-repository missions with their
 * tasks, prepared release trains, and cross-repository memory and decisions.
 */
export const workspacesSchema = /* sql */ `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_repositories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  role TEXT NOT NULL,
  remote TEXT,
  branch TEXT,
  languages TEXT NOT NULL,
  frameworks TEXT NOT NULL,
  commands TEXT NOT NULL,
  package_name TEXT,
  package_version TEXT,
  manifest TEXT,
  enrolled_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  UNIQUE (workspace_id, key),
  UNIQUE (workspace_id, project_id)
);
CREATE INDEX idx_workspace_repositories_workspace ON workspace_repositories(workspace_id, enrolled_at);

CREATE TABLE workspace_services (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_services_workspace ON workspace_services(workspace_id);

CREATE TABLE workspace_dependencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_repository_id TEXT NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  to_repository_id TEXT NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_dependencies_workspace ON workspace_dependencies(workspace_id);

CREATE TABLE workspace_contracts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, key)
);

CREATE TABLE workspace_contract_consumers (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES workspace_contracts(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES workspace_repositories(id) ON DELETE CASCADE,
  copy_path TEXT,
  provenance TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, repository_id)
);

CREATE TABLE workspace_contract_versions (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES workspace_contracts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  hash TEXT NOT NULL,
  "commit" TEXT,
  surface TEXT NOT NULL,
  parse_error TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE (contract_id, version)
);

CREATE TABLE workspace_missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  program_id TEXT,
  goal TEXT NOT NULL,
  state TEXT NOT NULL,
  resume_state TEXT,
  blocked_reason TEXT,
  plan TEXT,
  planner_run_id TEXT,
  verification TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_workspace_missions_workspace ON workspace_missions(workspace_id, created_at);
CREATE INDEX idx_workspace_missions_state ON workspace_missions(state);

CREATE TABLE workspace_tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES workspace_missions(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  key TEXT NOT NULL,
  repository TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  contracts TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT,
  base_commit TEXT,
  result_commit TEXT,
  result_branch TEXT,
  summary TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (mission_id, key)
);
CREATE INDEX idx_workspace_tasks_mission ON workspace_tasks(mission_id, ordinal);
CREATE INDEX idx_workspace_tasks_run ON workspace_tasks(run_id);

CREATE TABLE workspace_release_trains (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id TEXT,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  plan TEXT NOT NULL,
  publish_authorized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_release_trains_workspace ON workspace_release_trains(workspace_id, created_at);

CREATE TABLE workspace_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence TEXT NOT NULL,
  repositories TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_memory_workspace ON workspace_memory(workspace_id, created_at);

CREATE TABLE workspace_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_decisions_workspace ON workspace_decisions(workspace_id, created_at);
`
