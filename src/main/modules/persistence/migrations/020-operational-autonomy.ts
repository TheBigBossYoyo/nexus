/**
 * 0.9: operational autonomy. Purely additive.
 *
 * The Director Line (remote operator channel) keeps its identities, pairing state (hashes only), the seen-set of
 * provider updates, the outbox, delivery attempts, policy and settings here. No token, PIN or pairing code is ever
 * a column: tokens live in protected storage, the PIN and the code only as salted hashes.
 *
 * `progress_predictions` / `progress_accuracy` back the progress estimate and its calibration; `network_outages`
 * records the periods in which the provider could not be reached.
 */
export const operationalAutonomySchema = /* sql */ `
CREATE TABLE director_line_identities (
  channel TEXT NOT NULL, provider_user_id TEXT NOT NULL, label TEXT NOT NULL,
  paired_at TEXT NOT NULL, paired_via TEXT NOT NULL,
  PRIMARY KEY (channel, provider_user_id)
);
CREATE TABLE director_line_pairing_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  install_salt TEXT,
  code_channel TEXT, code_hash TEXT, code_expires_at TEXT, code_wrong_attempts INTEGER,
  pin_hash TEXT,
  attempts_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE director_line_seen (
  key TEXT PRIMARY KEY, seen_at TEXT NOT NULL
);
CREATE INDEX director_line_seen_at ON director_line_seen (seen_at);
CREATE TABLE director_line_outbox (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, event_json TEXT NOT NULL,
  call_attempts INTEGER NOT NULL DEFAULT 0, message_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, quiet_noted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE director_line_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, channel TEXT NOT NULL,
  at TEXT NOT NULL, outcome TEXT NOT NULL, provider_reference TEXT, error_class TEXT
);
CREATE INDEX director_line_deliveries_at ON director_line_deliveries (at);
CREATE TABLE director_line_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1), policy_json TEXT NOT NULL
);
CREATE TABLE director_line_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0,
  message_provider TEXT, voice_provider TEXT, telegram_offset INTEGER,
  relay_base_url TEXT
);

CREATE TABLE progress_predictions (
  run_id TEXT NOT NULL, at TEXT NOT NULL, low_seconds INTEGER NOT NULL, high_seconds INTEGER NOT NULL,
  percent INTEGER NOT NULL, confidence TEXT NOT NULL, wait TEXT NOT NULL
);
CREATE INDEX idx_progress_predictions_run ON progress_predictions (run_id, at);
CREATE TABLE progress_accuracy (
  run_id TEXT PRIMARY KEY, finished_at TEXT NOT NULL, samples INTEGER NOT NULL,
  coverage REAL NOT NULL, bias REAL NOT NULL, mean_width_ratio REAL NOT NULL
);
CREATE TABLE network_outages (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, record_json TEXT NOT NULL
);
CREATE INDEX idx_network_outages_started ON network_outages (started_at);
`
