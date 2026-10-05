/**
 * v0.6: providers. Purely additive. One row per agent session with the provider that ran it, the provider
 * the policy asked for, and why they differ when they do. `run_id` and `agent_id` are plain columns: the
 * record of who did the work outlives nothing it should not, and is removed with its run by the trigger.
 */
export const providersSchema = /* sql */ `
CREATE TABLE provider_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT,
  requested TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  runtime_version TEXT,
  auth_mode TEXT,
  reason TEXT NOT NULL,
  fallback_reason TEXT,
  session_id TEXT,
  outcome TEXT NOT NULL,
  error TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_provider_sessions_run ON provider_sessions(run_id, created_at);
CREATE INDEX idx_provider_sessions_session ON provider_sessions(session_id);
CREATE INDEX idx_provider_sessions_created ON provider_sessions(created_at);

CREATE TRIGGER provider_sessions_run_deleted AFTER DELETE ON runs
BEGIN
  DELETE FROM provider_sessions WHERE run_id = OLD.id;
END;
`
