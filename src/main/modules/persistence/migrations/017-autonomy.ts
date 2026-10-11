/**
 * 0.8: autonomy. Purely additive. A project is enrolled once with a profile; a grant is what the user allowed
 * beyond it; a boundary request is one question to the user, kept with its answer; the audit log records what
 * the capability broker decided. A PENDING request is unique per need (`dedupe_key`), which is what makes the
 * same need one question however often it is met. Nothing here is written from model output: the rows are
 * made by the broker from the user's decisions and from NEXUS's own description of a tool call.
 */
export const autonomySchema = /* sql */ `
CREATE TABLE autonomy_enrollments (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  profile TEXT NOT NULL CHECK(profile IN ('AUTONOMOUS_PROJECT','BALANCED','LOCKED_DOWN')),
  enrolled_at TEXT NOT NULL,
  policy_version TEXT NOT NULL
);

CREATE TABLE capability_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('ONCE','MISSION','PROJECT')),
  run_id TEXT,
  resource_kind TEXT NOT NULL,
  resource_value TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('USER','USER_POLICY')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  reason TEXT NOT NULL,
  request_id TEXT,
  consumed_at TEXT,
  revoked_at TEXT,
  CHECK((scope = 'PROJECT' AND run_id IS NULL) OR (scope <> 'PROJECT' AND run_id IS NOT NULL))
);
CREATE INDEX idx_capability_grants_project ON capability_grants(project_id, capability);

CREATE TABLE boundary_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  capability TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_value TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','GRANTED','DENIED','EXPIRED')),
  occurrences INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  decided_at TEXT,
  decided_scope TEXT,
  grant_id TEXT
);
CREATE UNIQUE INDEX idx_boundary_requests_pending ON boundary_requests(dedupe_key) WHERE state = 'PENDING';
CREATE INDEX idx_boundary_requests_key ON boundary_requests(dedupe_key, created_at);
CREATE INDEX idx_boundary_requests_project ON boundary_requests(project_id, state);

CREATE TABLE autonomy_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  severity TEXT NOT NULL,
  capability TEXT,
  outcome TEXT,
  authorized_by TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX idx_autonomy_audit_run ON autonomy_audit(run_id, seq);
CREATE INDEX idx_autonomy_audit_project ON autonomy_audit(project_id, seq);
`
