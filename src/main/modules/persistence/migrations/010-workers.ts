/**
 * v0.7: the worker manager and the scheduler's records. Purely additive.
 *
 * `workers` is one row per worker process the runtime ever started. `worker_leases` is one row per assignment
 * of an agent session to a worker; the two partial unique indexes are the durable form of "a worker holds at
 * most one assignment" and "an agent session is assigned to at most one worker". `schedule_firings` makes a
 * schedule's occurrence fire once however often the runtime restarts. `scheduler_decisions` is why an item got
 * capacity or waited, recorded when the answer changes.
 */
export const workersSchema = /* sql */ `
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,
  pid INTEGER,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT,
  stopped_at TEXT,
  exit_code INTEGER,
  error TEXT,
  assignments INTEGER NOT NULL DEFAULT 0,
  capabilities TEXT NOT NULL,
  lease_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  task_id TEXT,
  provider TEXT,
  session_id TEXT,
  worktree TEXT,
  assigned_at TEXT
);
CREATE INDEX idx_workers_state ON workers(state);
CREATE INDEX idx_workers_started ON workers(started_at);

CREATE TABLE worker_leases (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  reason TEXT
);
CREATE UNIQUE INDEX idx_worker_leases_active_agent ON worker_leases(agent_id) WHERE state = 'ACTIVE';
CREATE UNIQUE INDEX idx_worker_leases_active_worker ON worker_leases(worker_id) WHERE state = 'ACTIVE';
CREATE INDEX idx_worker_leases_state ON worker_leases(state, expires_at);

CREATE TABLE worker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_worker_events_worker ON worker_events(worker_id, id);

CREATE TABLE schedule_firings (
  schedule_id TEXT NOT NULL,
  occurrence TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  item_id TEXT,
  result TEXT,
  PRIMARY KEY (schedule_id, occurrence)
);

CREATE TABLE scheduler_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  item_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX idx_scheduler_decisions_item ON scheduler_decisions(item_id, id);
`
