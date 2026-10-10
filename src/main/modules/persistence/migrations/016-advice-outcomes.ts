/**
 * 0.7.2: what became of work that was admitted with advice. One row per source of advice (the specification a
 * mission was admitted with, or a Director request made about a mission) and run, written once when the run
 * ends. Director records are immutable, so the result of the work is a record of its own and not an edit of them.
 */
export const adviceOutcomesSchema = `
CREATE TABLE advice_outcomes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('SPECIFICATION','DIRECTOR')),
  source_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_kind, source_id, run_id)
);
CREATE INDEX advice_outcomes_project ON advice_outcomes(project_id, created_at);
`
