/**
 * v0.3: an overnight record supervises a workload, which is a mission run or an Arena campaign. The table is
 * rebuilt because `run_id` referenced `runs(id)` and a campaign is not a run; every row is copied and keeps
 * its values, with `workload_type` set to `mission`. A trigger keeps what the foreign key did: deleting a
 * run deletes the overnight record of that mission.
 */
export const workloadSchema = /* sql */ `
CREATE TABLE overnight_runs_v5 (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  workload_type TEXT NOT NULL DEFAULT 'mission',
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
INSERT INTO overnight_runs_v5 (
  id, run_id, workload_type, project_id, state, policy, "authorization", started_at, deadline_at, failsafe,
  terminal_reason, terminal_detail, final_report, report_path, report_saved_at, power_action, quota, watchdog,
  amendments, error, created_at, updated_at, finished_at
)
SELECT
  id, run_id, 'mission', project_id, state, policy, "authorization", started_at, deadline_at, failsafe,
  terminal_reason, terminal_detail, final_report, report_path, report_saved_at, power_action, quota, watchdog,
  amendments, error, created_at, updated_at, finished_at
FROM overnight_runs;
DROP TABLE overnight_runs;
ALTER TABLE overnight_runs_v5 RENAME TO overnight_runs;
CREATE INDEX idx_overnight_runs_state ON overnight_runs(state);
CREATE INDEX idx_overnight_runs_workload ON overnight_runs(workload_type, created_at);
CREATE TRIGGER overnight_runs_run_deleted AFTER DELETE ON runs
BEGIN
  DELETE FROM overnight_runs WHERE run_id = OLD.id AND workload_type = 'mission';
END;
`
