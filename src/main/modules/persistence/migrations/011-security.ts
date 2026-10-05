/**
 * v0.7: execution security. Purely additive. The decision log records every denied, approval-required and
 * audited tool decision (a redacted action summary, never file contents or environment values); file
 * provenance records which files an agent wrote, so a later run of that file is judged as agent-authored.
 * The log is bounded by pruning on insert (see SecurityDecisionRepository).
 */
export const securitySchema = /* sql */ `
CREATE TABLE security_decisions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  action TEXT NOT NULL,
  classification TEXT NOT NULL,
  provenance TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL
);
CREATE INDEX idx_security_decisions_run ON security_decisions(run_id, seq);

CREATE TABLE file_provenance (
  id TEXT PRIMARY KEY,
  worktree TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  sha256 TEXT,
  created_by_agent_id TEXT,
  modified_by_agent_id TEXT,
  task_id TEXT,
  run_id TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trust TEXT NOT NULL,
  UNIQUE (worktree, path_key)
);
CREATE INDEX idx_file_provenance_worktree ON file_provenance(worktree, updated_at);
`
