/**
 * 0.9.1: privilege sessions. Purely additive.
 *
 * `privilege_sessions` is one row per session the owner prepared (one UAC prompt each): its scope, what it was
 * given, when it was active and why it ended. `privileged_operations` is the receipt of every privileged attempt,
 * the refused ones included: what was asked, by whom, why, the reviews, the policy's decisions, what happened and
 * what was observed. Secrets are removed before a receipt is written; the program's output is cut.
 */
export const privilegeSessionsSchema = /* sql */ `
CREATE TABLE privilege_sessions (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, run_id TEXT, project_id TEXT, state TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, created_at TEXT NOT NULL, active_at TEXT, expires_at TEXT NOT NULL,
  ended_at TEXT, end_reason TEXT, uac_prompts INTEGER NOT NULL DEFAULT 0, elevated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX privilege_sessions_run ON privilege_sessions (run_id);
CREATE TABLE privileged_operations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT, run_id TEXT, project_id TEXT,
  task_id TEXT, requested_at TEXT NOT NULL, finished_at TEXT NOT NULL, capability TEXT NOT NULL, outcome TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);
CREATE INDEX privileged_operations_run ON privileged_operations (run_id, seq);
CREATE INDEX privileged_operations_session ON privileged_operations (session_id, seq);
`
