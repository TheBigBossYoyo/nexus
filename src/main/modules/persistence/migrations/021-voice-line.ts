/**
 * 0.9.1: the Director's voice line (standard SIP). Purely additive.
 *
 * `director_line_voice` holds the non-secret configuration of the voice line as one JSON row (the SIP address, the
 * server, the encryption wished for, the call policy). The SIP password is never a column: it lives in protected
 * storage. `director_line_calls` is a record of each call: when, which way, how it ended, what security was
 * negotiated. It never holds what was said.
 */
export const voiceLineSchema = /* sql */ `
CREATE TABLE director_line_voice (
  id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL
);
CREATE TABLE director_line_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, direction TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL, outcome TEXT NOT NULL, end_reason TEXT,
  authenticated INTEGER NOT NULL DEFAULT 0, signalling TEXT, media TEXT, end_to_end INTEGER,
  median_answer_ms INTEGER
);
CREATE INDEX director_line_calls_started ON director_line_calls (started_at);
`
