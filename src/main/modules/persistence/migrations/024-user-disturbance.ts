/**
 * 0.9.1: zero-disturbance testing. Purely additive.
 *
 * `user_disturbance_events` is what the presence meter saw of NEXUS's work on the owner's screen: when, what kind
 * (a window, a console, a dialog, the foreground taken), the process file name and the window class, and the runs at
 * work then. Never a window title or contents. `presentation_compatibility` is the evidence, per application and
 * mode, that a way of keeping it off the screen renders it as it is (or why it does not).
 */
export const userDisturbanceSchema = /* sql */ `
CREATE TABLE user_disturbance_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, process TEXT NOT NULL,
  window_class TEXT NOT NULL, run_ids_json TEXT NOT NULL
);
CREATE INDEX user_disturbance_events_at ON user_disturbance_events (at);
CREATE TABLE user_disturbance_runs (
  run_id TEXT NOT NULL, event_seq INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (run_id, event_seq)
);
CREATE TABLE presentation_compatibility (
  project_id TEXT NOT NULL, app_key TEXT NOT NULL, mode TEXT NOT NULL, verdict TEXT NOT NULL,
  measured_at TEXT NOT NULL, evidence_json TEXT NOT NULL, PRIMARY KEY (project_id, app_key, mode)
);
`
