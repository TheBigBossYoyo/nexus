/**
 * v0.2.1: Overnight Mode. Purely additive: no earlier table is altered. The overnight record keeps the
 * exact policy the user approved, the authorization, the failsafe timer and the final power action;
 * power_audit records every command the power controller was asked to run.
 */
export const overnightSchema = /* sql */ `
CREATE TABLE overnight_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  policy TEXT NOT NULL,
  "authorization" TEXT NOT NULL,
  started_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  failsafe TEXT,
  terminal_reason TEXT,
  terminal_detail TEXT,
  final_report TEXT,
  report_path TEXT,
  report_saved_at TEXT,
  power_action TEXT,
  quota TEXT,
  watchdog TEXT NOT NULL,
  amendments TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_overnight_runs_state ON overnight_runs(state);

CREATE TABLE power_audit (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  operation TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_power_audit_run ON power_audit(run_id, created_at);

CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_run_checkpoints_run ON run_checkpoints(run_id, created_at);
`
