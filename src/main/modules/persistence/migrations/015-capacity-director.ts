export const capacityDirectorSchema = `
CREATE TABLE capacity_routing_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX capacity_routing_operation ON capacity_routing_records(operation_id,created_at);
CREATE TABLE director_records (
  id TEXT PRIMARY KEY,
  invocation_id TEXT REFERENCES intelligence_artifacts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('DECISION','ESCALATION','OUTCOME')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX director_records_project ON director_records(project_id,kind,created_at);
`
