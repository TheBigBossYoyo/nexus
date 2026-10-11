export const canonicalIntentsSchema = `
ALTER TABLE raw_user_intents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
CREATE TABLE compilation_context_refs (
  artifact_id TEXT NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  context_version TEXT NOT NULL,
  PRIMARY KEY(artifact_id,context_id)
);
CREATE TABLE engineering_admissions (
  kind TEXT NOT NULL CHECK(kind IN ('PROGRAM','PROGRAM_REPLAN','WORKSPACE_MISSION','WORKSPACE_PROGRAM','TASK_ADDITION','TASK_INSTRUCTION','RUN_INSTRUCTION')),
  entity_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY(kind,entity_id)
);
CREATE TABLE engineering_admission_history (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  UNIQUE(kind,entity_id,spec_id)
);
CREATE INDEX engineering_admission_history_entity ON engineering_admission_history(kind,entity_id,ordinal);
`
