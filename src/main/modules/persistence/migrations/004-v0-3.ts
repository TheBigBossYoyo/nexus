/**
 * v0.3: usage intelligence, quota recovery, Arena, adaptive policy, speculative execution.
 * Purely additive: no earlier table is altered. The hidden project of an Arena trial is an ordinary
 * projects row that arena_trials.project_id points at.
 * Ids that point at runs, tasks or agents are plain text without foreign keys where the history must
 * survive the deletion of what it describes.
 */
export const v03Schema = /* sql */ `
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  sdk_session_id TEXT,
  role TEXT,
  model TEXT,
  strategy TEXT,
  arena_campaign_id TEXT,
  day TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  turns INTEGER,
  duration_ms INTEGER,
  cost_usd REAL,
  availability TEXT NOT NULL,
  limit_type TEXT,
  utilization REAL,
  utilization_unit TEXT,
  reset_at TEXT,
  retry_after_ms INTEGER,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  raw_classification TEXT
);
CREATE INDEX idx_usage_events_created ON usage_events(created_at);
CREATE INDEX idx_usage_events_type ON usage_events(event_type, created_at);
CREATE INDEX idx_usage_events_run ON usage_events(run_id, event_type);
CREATE INDEX idx_usage_events_day ON usage_events(day, event_type);
CREATE INDEX idx_usage_events_model ON usage_events(model, event_type);
CREATE INDEX idx_usage_events_strategy ON usage_events(strategy, event_type);
CREATE INDEX idx_usage_events_campaign ON usage_events(arena_campaign_id, event_type);
CREATE INDEX idx_usage_events_agent ON usage_events(agent_id);
CREATE INDEX idx_usage_events_task ON usage_events(task_id);

CREATE TABLE usage_windows (
  id TEXT PRIMARY KEY,
  limit_type TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  utilization_percent REAL,
  reset_at TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE quota_pauses (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  scope TEXT NOT NULL,
  state TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  limit_type TEXT,
  reset_at TEXT,
  reset_confidence TEXT NOT NULL,
  next_check_at TEXT,
  probes INTEGER NOT NULL DEFAULT 0,
  checkpoint_id TEXT,
  resume_state TEXT,
  ended_at TEXT,
  end_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_quota_pauses_state ON quota_pauses(state, scope);
CREATE INDEX idx_quota_pauses_run ON quota_pauses(run_id, created_at);
CREATE INDEX idx_quota_pauses_paused ON quota_pauses(paused_at);

CREATE TABLE quota_resumes (
  id TEXT PRIMARY KEY,
  pause_id TEXT NOT NULL REFERENCES quota_pauses(id) ON DELETE CASCADE,
  run_id TEXT,
  attempted_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  result TEXT NOT NULL,
  method TEXT NOT NULL,
  detail TEXT,
  waited_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_quota_resumes_pause ON quota_resumes(pause_id, created_at);
CREATE INDEX idx_quota_resumes_run ON quota_resumes(run_id, created_at);

CREATE TABLE arena_cases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  category TEXT NOT NULL,
  complexity TEXT NOT NULL,
  risk TEXT NOT NULL,
  latest_version INTEGER NOT NULL,
  source_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE arena_case_versions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES arena_cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  evaluator_hash TEXT NOT NULL,
  fixture_hash TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, version)
);

CREATE TABLE arena_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  pause_reason TEXT,
  case_version_ids TEXT NOT NULL,
  strategies TEXT NOT NULL,
  repetitions INTEGER NOT NULL,
  model_preset TEXT NOT NULL,
  budgets TEXT NOT NULL,
  overnight INTEGER NOT NULL DEFAULT 0,
  policy_snapshot_id TEXT,
  nexus_version TEXT NOT NULL,
  environment TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_arena_campaigns_state ON arena_campaigns(state, created_at);
CREATE INDEX idx_arena_campaigns_created ON arena_campaigns(created_at);

CREATE TABLE arena_trials (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES arena_campaigns(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  case_version_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  repetition INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  repo_path TEXT,
  baseline_commit TEXT,
  result_commit TEXT,
  policy_snapshot_id TEXT,
  task_profile_id TEXT,
  models TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(campaign_id, case_version_id, strategy, repetition)
);
CREATE INDEX idx_arena_trials_campaign ON arena_trials(campaign_id, ordinal);
CREATE INDEX idx_arena_trials_state ON arena_trials(state);
CREATE INDEX idx_arena_trials_run ON arena_trials(run_id);
CREATE INDEX idx_arena_trials_case ON arena_trials(case_id, strategy);
CREATE INDEX idx_arena_trials_finished ON arena_trials(finished_at);

CREATE TABLE arena_trial_metrics (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL UNIQUE REFERENCES arena_trials(id) ON DELETE CASCADE,
  build_passed INTEGER,
  typecheck_passed INTEGER,
  tests_passed INTEGER,
  hidden_passed INTEGER,
  acceptance_total INTEGER,
  acceptance_passed INTEGER,
  verifier_passed INTEGER,
  critical_findings INTEGER NOT NULL DEFAULT 0,
  high_findings INTEGER NOT NULL DEFAULT 0,
  medium_findings INTEGER NOT NULL DEFAULT 0,
  repairs INTEGER NOT NULL DEFAULT 0,
  wall_clock_ms INTEGER,
  sessions INTEGER NOT NULL DEFAULT 0,
  turns INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  tool_calls INTEGER,
  human_interventions INTEGER NOT NULL DEFAULT 0,
  approvals INTEGER NOT NULL DEFAULT 0,
  manual_retries INTEGER NOT NULL DEFAULT 0,
  blockers INTEGER NOT NULL DEFAULT 0,
  crashed_agents INTEGER NOT NULL DEFAULT 0,
  recovered_sessions INTEGER NOT NULL DEFAULT 0,
  scheduler_failures INTEGER NOT NULL DEFAULT 0,
  unfinished_tasks INTEGER NOT NULL DEFAULT 0,
  quota_pauses INTEGER NOT NULL DEFAULT 0,
  quota_wait_ms INTEGER NOT NULL DEFAULT 0,
  auto_resume_successes INTEGER NOT NULL DEFAULT 0,
  throttle_events INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE arena_evaluations (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES arena_trials(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  output TEXT NOT NULL,
  passed INTEGER NOT NULL,
  skipped_reason TEXT,
  evaluator_hash TEXT NOT NULL,
  score_version TEXT NOT NULL,
  score REAL NOT NULL,
  score_breakdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_arena_evaluations_trial ON arena_evaluations(trial_id, created_at);

CREATE TABLE task_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  run_id TEXT,
  arena_trial_id TEXT,
  context_key TEXT NOT NULL,
  features TEXT NOT NULL,
  profiler_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_profiles_run ON task_profiles(run_id);
CREATE INDEX idx_task_profiles_context ON task_profiles(context_key, created_at);

CREATE TABLE mission_outcomes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  task_profile_id TEXT,
  context_key TEXT NOT NULL,
  strategy TEXT NOT NULL,
  requested_strategy TEXT NOT NULL,
  planning_mode TEXT NOT NULL,
  review_mode TEXT NOT NULL,
  policy_decision_id TEXT,
  policy_snapshot_id TEXT,
  models TEXT NOT NULL,
  agents INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  tasks INTEGER NOT NULL,
  tasks_completed INTEGER NOT NULL,
  repairs INTEGER NOT NULL,
  reviews INTEGER NOT NULL,
  review_rejections INTEGER NOT NULL,
  verification_passed INTEGER,
  elapsed_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  quota_pauses INTEGER NOT NULL DEFAULT 0,
  quota_wait_ms INTEGER NOT NULL DEFAULT 0,
  human_interventions INTEGER NOT NULL DEFAULT 0,
  terminal TEXT NOT NULL,
  success INTEGER NOT NULL,
  is_arena INTEGER NOT NULL DEFAULT 0,
  nexus_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mission_outcomes_context ON mission_outcomes(context_key, strategy, created_at);
CREATE INDEX idx_mission_outcomes_created ON mission_outcomes(created_at);
CREATE INDEX idx_mission_outcomes_project ON mission_outcomes(project_id, created_at);

CREATE TABLE policy_snapshots (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  origin TEXT NOT NULL,
  parent_id TEXT,
  preferences TEXT NOT NULL,
  config TEXT NOT NULL,
  routing TEXT NOT NULL,
  note TEXT
);

CREATE TABLE policy_decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  project_id TEXT,
  task_profile_id TEXT,
  snapshot_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  context_key TEXT NOT NULL,
  evidence_context_key TEXT,
  strategy TEXT NOT NULL,
  planning_mode TEXT NOT NULL,
  worker_count INTEGER NOT NULL,
  review_depth TEXT NOT NULL,
  speculative_candidates INTEGER NOT NULL,
  model_policies TEXT NOT NULL,
  layer TEXT NOT NULL,
  exploration INTEGER NOT NULL,
  seed INTEGER,
  reason TEXT NOT NULL,
  evidence_summary TEXT NOT NULL,
  resource_notes TEXT NOT NULL,
  usage_status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_policy_decisions_run ON policy_decisions(run_id);
CREATE INDEX idx_policy_decisions_created ON policy_decisions(created_at);

CREATE TABLE policy_candidates (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  from_strategy TEXT NOT NULL,
  to_strategy TEXT NOT NULL,
  arena_trials INTEGER NOT NULL,
  missions INTEGER NOT NULL,
  label TEXT NOT NULL,
  expected TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  shadow TEXT,
  status TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_policy_candidates_status ON policy_candidates(status, created_at);

CREATE TABLE policy_promotions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  candidate_id TEXT,
  from_snapshot_id TEXT,
  to_snapshot_id TEXT NOT NULL,
  "by" TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_policy_promotions_created ON policy_promotions(created_at);

CREATE TABLE strategy_statistics (
  id TEXT PRIMARY KEY,
  context_key TEXT NOT NULL,
  strategy TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  effective_n REAL NOT NULL,
  effective_successes REAL NOT NULL,
  pass_rate REAL,
  pass_interval TEXT,
  median_duration_ms REAL,
  mean_duration_ms REAL,
  mean_sessions REAL,
  mean_observed_tokens REAL,
  mean_repairs REAL,
  repair_distribution TEXT NOT NULL,
  stability_failures INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  newest_at TEXT,
  oldest_at TEXT,
  computed_at TEXT NOT NULL,
  UNIQUE(context_key, strategy, kind)
);

CREATE TABLE speculative_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  candidate_count INTEGER NOT NULL,
  state TEXT NOT NULL,
  winner_candidate_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_speculative_runs_run ON speculative_runs(run_id, created_at);
CREATE INDEX idx_speculative_runs_task ON speculative_runs(task_id);

CREATE TABLE candidate_results (
  id TEXT PRIMARY KEY,
  speculative_run_id TEXT NOT NULL REFERENCES speculative_runs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  label TEXT NOT NULL,
  agent_id TEXT,
  sdk_session_id TEXT,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  head_commit TEXT,
  evidence TEXT NOT NULL,
  diff_patch TEXT,
  rank INTEGER,
  outcome TEXT NOT NULL,
  cleaned_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(speculative_run_id, label)
);
CREATE INDEX idx_candidate_results_run ON candidate_results(run_id);

CREATE TABLE tournament_decisions (
  id TEXT PRIMARY KEY,
  speculative_run_id TEXT NOT NULL UNIQUE REFERENCES speculative_runs(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  winner_label TEXT,
  ranking TEXT NOT NULL,
  comparisons TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tournament_decisions_run ON tournament_decisions(run_id);
`
