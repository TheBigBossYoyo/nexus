export const intelligenceSchema = `
CREATE TABLE raw_user_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER raw_intent_immutable BEFORE UPDATE ON raw_user_intents
BEGIN SELECT RAISE(ABORT, 'Raw user intent is immutable'); END;
CREATE TABLE intelligence_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intent_id TEXT REFERENCES raw_user_intents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('compilation','director','escalation','routing')),
  identity TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,kind,identity)
);
CREATE INDEX intelligence_artifacts_history ON intelligence_artifacts(project_id,kind,created_at DESC);
CREATE TABLE capacity_checkpoints (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`
