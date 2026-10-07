/**
 * v0.7: the control plane. Purely additive. The global queue of work items (one per workload that uses
 * agents), durable schedules, and the incidents the control plane recorded. `ref_id` is a plain column: an
 * item outlives nothing it should not, and a finished item is history.
 */
export const controlPlaneSchema = /* sql */ `
CREATE TABLE global_work_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  ref_id TEXT,
  title TEXT NOT NULL,
  priority TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL,
  requested_agents INTEGER NOT NULL,
  deadline_at TEXT,
  not_before TEXT,
  schedule_id TEXT,
  held_by_user INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_global_work_items_state ON global_work_items(state, priority, position);
CREATE INDEX idx_global_work_items_ref ON global_work_items(type, ref_id);
CREATE INDEX idx_global_work_items_finished ON global_work_items(finished_at);

CREATE TABLE control_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rule TEXT NOT NULL,
  action TEXT NOT NULL,
  priority TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE control_incidents (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  summary TEXT NOT NULL,
  item_id TEXT
);
CREATE INDEX idx_control_incidents_at ON control_incidents(at);
`
