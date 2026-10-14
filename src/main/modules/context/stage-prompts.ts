import type { FilterMode } from '@main/modules/token/filter'
import { renderOriginalIntent, renderCompiledAdvice } from './compiled'
import type {
  CommandResult,
  Handoff,
  MemoryEntry,
  MissionPlan,
  ProjectProfile,
  ReviewFinding,
  Run,
  RunMode,
  Task,
  VerificationFailure,
} from '@shared/domain'
import type { PlanCritiqueOutput, RepositoryFact } from '@shared/v2'
import type { DedupedFinding } from '@main/modules/review'
import {
  SECTION_LIMITS,
  assemble,
  boundedList,
  bullets,
  criteriaSection,
  renderCheckCommands,
  renderChecks,
  renderHandoff,
  renderOrchestrationEvidence,
  renderSentMessages,
  renderTaskSpec,
  truncate,
} from './render'
import type { OrchestrationEvidence, PackSection } from './render'

type Pack = { prompt: string; sections: PackSection[] }
type TaskSpec = Pick<Task, 'key' | 'title' | 'description' | 'suggestedFiles' | 'acceptanceCriteria'>

// ───────────────────────────── planner ─────────────────────────────

const MODE_GUIDANCE: Record<RunMode, string> = {
  ask: 'Mode ASK: the request is a question. Produce a minimal plan: one read-only researcher task that answers it with repository evidence. No implementation tasks.',
  build:
    'Mode BUILD: plan the implementation of the request as a small DAG of bounded tasks. Prefer fewer, well-scoped tasks; parallelize only where files and outputs are independent. Include tests for new behaviour. Acceptance criteria are about what each task builds; never make "the whole test suite (or build, or lint) passes" a criterion of a task, and do not add a task whose only purpose is to run the project checks: NEXUS runs the checks scoped to the files of each task after it, and every check in full once when the mission integrates.',
  swarm:
    'Mode SWARM: produce the maximum useful safe parallel decomposition. Split the work into as many independent tasks as file boundaries allow, keep the dependency graph shallow and wide, and keep suggestedFiles disjoint between parallel tasks. Add a final integration or test task only where the pieces genuinely need joining. Do not split work so finely that tasks cannot be verified on their own.',
  repair:
    'Mode REPAIR: the request describes a defect. Plan reproduce -> diagnose -> fix -> regression test. First a task that reproduces the failure and identifies the root cause with evidence (role debugger or researcher), then a fix task that depends on it, and the regression test as part of the fix task or a following task. Acceptance criteria must include that the original failure no longer occurs.',
  audit:
    'Mode AUDIT: no modifications. Plan parallel read-only review tasks (roles security_reviewer and reviewer; researcher for performance/quality as needed) covering security, architecture, performance, and code quality, each on a distinct area with its own suggestedFiles, then exactly one synthesis task (kind of work: combine findings) that depends on ALL review tasks. No task may modify files; requiresApproval is false.',
  mission:
    'Mode MISSION: this is a large, multi-feature, long-running request. Decompose it into features, each with its own implementation and test tasks, arranged as a DAG with explicit dependencies between features that share interfaces. Order work so each completed feature leaves the repository in a working state. Use architect tasks first where interfaces must be settled before parallel work. Include a final integration verification task.',
  loop: 'Mode LOOP: work proceeds in bounded iterations against explicit acceptance criteria. Write mission acceptance criteria that are objectively checkable by commands or code inspection (the loop stops when they all pass or the iteration limit is reached). Plan the first iteration only as concrete tasks; avoid open-ended criteria.',
}

export function renderProfile(profile: ProjectProfile): string {
  const lines = [
    `Git: ${profile.isGitRepo ? `branch ${profile.currentBranch ?? '(detached)'}, head ${profile.headCommit ?? 'none'}${profile.dirty ? ', uncommitted changes' : ''}` : 'not a repository'}`,
    `Languages: ${profile.languages.join(', ') || 'unknown'}`,
    `Frameworks: ${profile.frameworks.join(', ') || 'none detected'}`,
    `Package managers: ${profile.packageManagers.join(', ') || 'none detected'}`,
    `Size: ${profile.fileCount} files`,
    'Check commands:',
    renderCheckCommands(profile.commands),
  ]
  const scripts = Object.keys(profile.scripts)
  if (scripts.length > 0) lines.push(`Scripts: ${scripts.join(', ')}`)
  if (profile.docs.length > 0) lines.push(`Docs: ${profile.docs.join(', ')}`)
  if (profile.hasClaudeMd) lines.push('CLAUDE.md present')
  if (profile.generatedPaths.length > 0) {
    lines.push(`Generated/vendor paths (ignore): ${profile.generatedPaths.join(', ')}`)
  }
  return truncate(lines.join('\n'), SECTION_LIMITS.profile)
}

export interface PlannerPromptInput {
  run: Run
  profile: ProjectProfile
  memory: MemoryEntry[]
  /** v0.7.1: the Context Graph section for the request (the map and what was selected), when the graph is on. */
  knowledge?: string | null
  feedback?: string
  previousErrors?: string[]
  previousPlan?: MissionPlan
  /** Consensus mode: this planner's own brief. It never sees another planner's output. */
  lens?: { label: string; guidance: string }
}

export function buildPlannerPrompt(input: PlannerPromptInput): Pack {
  const { run } = input
  const modeGuidance = MODE_GUIDANCE[run.mode]
  const limits = [
    `Maximum parallel agents: ${run.config.maxParallelAgents}`,
    `Maximum iterations: ${run.config.maxIterations}`,
    `Maximum retries per task: ${run.config.maxRetriesPerTask}`,
  ].join('\n')

  const memory = input.memory.length
    ? boundedList(
        input.memory.map((m) => `- ${m.title}: ${m.content}`),
        SECTION_LIMITS.memory,
        'memory entries',
      )
    : null

  const revision =
    input.previousPlan !== undefined
      ? `This is a revision. Previous plan:\n${truncate(JSON.stringify(input.previousPlan, null, 1), SECTION_LIMITS.plan)}`
      : null

  const errors = input.previousErrors?.length
    ? `The previous plan was rejected for these reasons. Fix every one:\n${bullets(input.previousErrors)}`
    : null

  const feedback = input.feedback?.trim()
    ? `Reviewer/user feedback to incorporate:\n${truncate(input.feedback, SECTION_LIMITS.userFeedback)}`
    : null

  return assemble([
    { name: 'Request', body: renderOriginalIntent(run) },
    { name: 'Compiled specification with provenance', body: renderCompiledAdvice(run) },
    { name: 'Mode', body: modeGuidance },
    { name: 'Limits', body: limits },
    { name: 'Planning lens', body: input.lens ? `You are ${input.lens.label}. ${input.lens.guidance}` : null },
    { name: 'Project profile', body: renderProfile(input.profile) },
    { name: 'Project memory', body: memory },
    { name: 'Project knowledge', body: input.knowledge ?? null },
    { name: 'Plan revision', body: revision },
    { name: 'Plan validation errors', body: errors },
    { name: 'Feedback', body: feedback },
    {
      name: 'Instructions',
      body: 'Explore the repository read-only to ground the plan, then return the MissionPlan. Do not include file contents in the plan.',
    },
  ])
}

// ───────────────────────────── review ─────────────────────────────

export interface ReviewPromptInput {
  task: TaskSpec
  missionCriteria: string[]
  diffStat: string
  patch: string
  checkResults: CommandResult[]
  /** v0.7.1: how check output is shown. Absent means failures first, then the tail. */
  checkOutputMode?: FilterMode
  attempt: number
  /** Dual review: this reviewer's focus. */
  lens?: string
  /** 0.7.2: the user's instructions in force (the request and every amendment), from `renderInstructionsInForce`. */
  instructions?: string | null
  /** From TaskEvidenceBuilder. The reviewer sees only the messages the task's agents sent (type, recipient, subject), never their reasoning. */
  evidence?: OrchestrationEvidence
}

/**
 * Deliberately accepts no implementer reasoning, summary, or self-review: the reviewer judges the
 * diff against the requirements only.
 */
export function buildReviewPrompt(input: ReviewPromptInput): Pack {
  return assemble([
    { name: 'Requirements', body: renderTaskSpec(input.task) },
    { name: 'User instructions in force', body: input.instructions ?? null },
    { name: 'Acceptance criteria', body: criteriaSection(input.task, input.missionCriteria) },
    { name: 'Diff summary', body: truncate(input.diffStat, SECTION_LIMITS.diffStat) },
    { name: 'Patch', body: input.patch.trim() ? truncate(input.patch, SECTION_LIMITS.patch) : null },
    { name: 'Check results', body: renderChecks(input.checkResults, input.checkOutputMode) },
    { name: 'Orchestration records', body: input.evidence ? renderSentMessages(input.evidence.messages, input.evidence.omittedMessages ?? 0) : null },
    { name: 'Review focus', body: input.lens ?? null },
    {
      name: 'Instructions',
      body: `Review attempt ${input.attempt}. Review the change in the current working directory against the requirements. Read the surrounding code, not only the patch. Return findings with evidence; return an empty findings list if you find no concrete defect.`,
    },
  ])
}

// ───────────────────────────── verification ─────────────────────────────

export interface VerifierPromptInput {
  task: TaskSpec
  missionCriteria: string[]
  diffStat: string
  checkResults: CommandResult[]
  /** v0.7.1: how check output is shown. Absent means failures first, then the tail. */
  checkOutputMode?: FilterMode
  reviewSummary?: string
  evidence?: OrchestrationEvidence
  /** 0.7.2: the user's instructions in force (the request and every amendment), from `renderInstructionsInForce`. */
  instructions?: string | null
}

export function buildVerifierPrompt(input: VerifierPromptInput): Pack {
  return assemble([
    { name: 'Task', body: renderTaskSpec(input.task) },
    { name: 'User instructions in force', body: input.instructions ?? null },
    { name: 'Acceptance criteria', body: criteriaSection(input.task, input.missionCriteria) },
    { name: 'Diff summary', body: truncate(input.diffStat, SECTION_LIMITS.diffStat) },
    { name: 'Check results', body: renderChecks(input.checkResults, input.checkOutputMode) },
    { name: 'Orchestration evidence', body: input.evidence ? renderOrchestrationEvidence(input.evidence) : null },
    {
      name: 'Review summary',
      body: input.reviewSummary ? truncate(input.reviewSummary, SECTION_LIMITS.findings) : null,
    },
    {
      name: 'Instructions',
      body: 'Verify each task criterion independently by inspecting the code and running checks. Return one entry per criterion (task and mission criteria that apply to this task) with evidence. List a failure for every criterion that did not pass.',
    },
  ])
}

export interface MissionVerifierPromptInput {
  run: Run
  missionCriteria: string[]
  diffStat: string
  checkResults: CommandResult[]
  /** v0.7.1: how check output is shown. Absent means failures first, then the tail. */
  checkOutputMode?: FilterMode
  planSummary?: string
  evidence?: OrchestrationEvidence
  /** 0.7.2: the user's instructions in force (the request and every amendment), from `renderInstructionsInForce`. */
  instructions?: string | null
}

/** Final acceptance of the whole mission on the integration branch (the current working directory). */
export function buildMissionVerifierPrompt(input: MissionVerifierPromptInput): Pack {
  const branch = input.run.integrationBranch
  return assemble([
    { name: 'Original request', body: renderOriginalIntent(input.run) },
    { name: 'Compiled specification with provenance', body: renderCompiledAdvice(input.run) },
    { name: 'User instructions in force', body: input.instructions ?? null },
    { name: 'Plan summary', body: input.planSummary ? truncate(input.planSummary, SECTION_LIMITS.criteria) : null },
    {
      name: 'Mission acceptance criteria',
      body: input.missionCriteria.length > 0 ? truncate(bullets(input.missionCriteria), SECTION_LIMITS.criteria) : null,
    },
    {
      name: 'Integration branch',
      body: branch ? `${branch} (base commit ${input.run.baseCommit ?? 'unknown'}); it is checked out in the current working directory.` : null,
    },
    { name: 'Diff summary', body: truncate(input.diffStat, SECTION_LIMITS.diffStat) },
    { name: 'Check results', body: renderChecks(input.checkResults, input.checkOutputMode) },
    { name: 'Orchestration evidence', body: input.evidence ? renderOrchestrationEvidence(input.evidence) : null },
    {
      name: 'Instructions',
      body: [
        'Verify every mission acceptance criterion against the integrated code. Run the project checks yourself. Return one entry per criterion with evidence and list a failure for each that did not pass.',
        'The criteria were written with the first version of the plan. If the orchestration evidence lists graph revisions, the plan was changed during the run by a validated proposal: a criterion that only restates the scope of the original plan (for example an exact list of files or tasks) passes when the difference is the work a recorded revision added, and that work itself is correct. Say so in the evidence for that criterion.',
        'A criterion that depends on something you are not allowed to do (for example a command your role may not run) is not a defect of the work: check it by the means you have (read the code and the tests, use the recorded check results and the quoted records) and fail it only when you find evidence that it is not met.',
      ].join('\n'),
    },
  ])
}

// ───────────────────────────── repair ─────────────────────────────

export interface RepairPromptInput {
  task: TaskSpec
  failure: { kind: 'checks' | 'review' | 'verification'; summary: string; details: string }
  findings?: ReviewFinding[]
  failures?: VerificationFailure[]
  checkResults?: CommandResult[]
  checkOutputMode?: FilterMode
  evidence?: OrchestrationEvidence
  /** 0.7.2: the user's instructions in force (the request and every amendment), from `renderInstructionsInForce`. */
  instructions?: string | null
}

export function renderFinding(f: ReviewFinding): string {
  const where = f.file ? ` (${f.file}${f.lineStart !== null ? `:${f.lineStart}` : ''})` : ''
  const fix = f.suggestedCorrection ? `\n  Suggested correction: ${f.suggestedCorrection}` : ''
  return `- [${f.severity}/${f.category}] ${f.title}${where}\n  ${f.description}\n  Evidence: ${f.evidence}${fix}`
}

function renderVerificationFailure(f: VerificationFailure): string {
  const files = f.relevantFiles.length > 0 ? `\n  Relevant files: ${f.relevantFiles.join(', ')}` : ''
  const cause = f.likelyCause ? `\n  Likely cause: ${f.likelyCause}` : ''
  return `- Criterion: ${f.criterion}\n  Evidence: ${f.evidence}${cause}${files}`
}

export function buildRepairPrompt(input: RepairPromptInput): Pack {
  const header = `Your previous implementation of this task did not pass ${input.failure.kind}. Address every issue below in this worktree, on the current branch, and commit the fix.`
  return assemble([
    { name: 'Repair request', body: header },
    { name: 'Task', body: renderTaskSpec(input.task) },
    { name: 'User instructions in force', body: input.instructions ?? null },
    { name: 'Acceptance criteria', body: criteriaSection(input.task, []) },
    {
      name: 'Failure',
      body: truncate(`${input.failure.summary}\n\n${input.failure.details}`, SECTION_LIMITS.failure),
    },
    {
      name: 'Review findings',
      body: input.findings?.length
        ? boundedList(input.findings.map(renderFinding), SECTION_LIMITS.findings, 'findings')
        : null,
    },
    {
      name: 'Failed criteria',
      body: input.failures?.length
        ? boundedList(input.failures.map(renderVerificationFailure), SECTION_LIMITS.findings, 'failures')
        : null,
    },
    { name: 'Check results', body: input.checkResults ? renderChecks(input.checkResults, input.checkOutputMode) : null },
    { name: 'Orchestration evidence', body: input.evidence ? renderOrchestrationEvidence(input.evidence) : null },
    {
      name: 'Instructions',
      body: 'Diagnose the root cause of each issue before changing code. Confirm a finding against the code first; if one is wrong, say why in your summary instead of changing correct code. Add or update tests for what you fix, re-run the relevant checks, and finish with a concise summary.',
    },
  ])
}

// ───────────────────────────── handoff ─────────────────────────────

export function buildHandoffRequestPrompt(): string {
  return 'Your session is about to be ended or rotated. Stop working and produce a structured handoff now so a fresh session can continue: completedWork (what is done), commits (hashes created), filesChanged, unresolvedIssues, importantFindings (facts a successor must know, with evidence), nextSteps (concrete and ordered). Be factual; list only what you actually did and verified. Do not make further changes.'
}

export interface ResumeFromHandoffInput {
  task: TaskSpec
  handoff: Handoff
  worktreePath: string
  branch: string
  /** 0.7.2: the user's instructions in force (the request and every amendment), from `renderInstructionsInForce`. */
  instructions?: string | null
  /** 0.7.2: the mission's acceptance criteria; the first session had them in its pack. */
  missionCriteria?: string[]
}

export function buildResumeFromHandoffPrompt(input: ResumeFromHandoffInput): Pack {
  return assemble([
    {
      name: 'Resuming task',
      body: 'A previous session worked on this task and was ended. Continue from its handoff rather than starting over. Verify the current state of the worktree (git status, git log, run the checks) before relying on the handoff: it may be incomplete.',
    },
    { name: 'Task', body: renderTaskSpec(input.task) },
    { name: 'User instructions in force', body: input.instructions ?? null },
    { name: 'Acceptance criteria', body: criteriaSection(input.task, input.missionCriteria ?? []) },
    { name: 'Handoff', body: renderHandoff(input.handoff) ?? 'The previous session reported no progress.' },
    { name: 'Repository state', body: `Worktree: ${input.worktreePath}\nBranch: ${input.branch}` },
  ])
}

// ───────────────────────────── audit synthesis ─────────────────────────────

export interface AuditSynthesisInput {
  run: Run
  auditOutputs: { key: string; title: string; summary: string }[]
  missionCriteria: string[]
}

export function buildAuditSynthesisPrompt(input: AuditSynthesisInput): Pack {
  const outputs = input.auditOutputs.length
    ? boundedList(
        input.auditOutputs.map(
          (o) => `### ${o.key}: ${o.title}\n${truncate(o.summary, SECTION_LIMITS.dependencyItem * 2)}`,
        ),
        SECTION_LIMITS.dependencies * 2,
        'audit reports',
      )
    : null
  return assemble([
    { name: 'Audit request', body: truncate(input.run.prompt, SECTION_LIMITS.request) },
    { name: 'Audit reports', body: outputs },
    {
      name: 'Mission criteria',
      body: input.missionCriteria.length > 0 ? bullets(input.missionCriteria) : null,
    },
    {
      name: 'Instructions',
      body: 'Synthesize the reports into one prioritized audit: deduplicate overlapping findings, resolve contradictions by checking the code, and drop claims you cannot confirm. Order by severity; for each finding give evidence (file and line), impact, and a recommended fix. End with a short overall assessment. This is read-only: do not modify any file.',
    },
  ])
}

// ───────────────────────────── consensus planning ─────────────────────────────

export interface CandidatePlan {
  label: string
  plan: MissionPlan
}

const planJson = (plan: MissionPlan): string => truncate(JSON.stringify(plan, null, 1), SECTION_LIMITS.plan)

function renderCandidates(candidates: readonly CandidatePlan[]): string {
  return candidates.map((c) => `### ${c.label}\n${planJson(c.plan)}`).join('\n\n')
}

export interface CriticPromptInput {
  run: Run
  profile: ProjectProfile
  candidates: readonly CandidatePlan[]
}

/** The critic sees only the structured candidate plans and the project profile: never a planner's transcript. */
export function buildCriticPrompt(input: CriticPromptInput): Pack {
  return assemble([
    { name: 'Request', body: truncate(input.run.prompt, SECTION_LIMITS.request) },
    { name: 'Mode', body: MODE_GUIDANCE[input.run.mode] },
    { name: 'Project profile', body: renderProfile(input.profile) },
    { name: 'Candidate plans', body: renderCandidates(input.candidates) },
    {
      name: 'Instructions',
      body: 'Critique the candidate plans against the repository and the request. Return findings that name the candidate they are about (use its exact label, or "all"), and name the candidate the synthesis should start from in preferredCandidate.',
    },
  ])
}

export interface SynthesizerPromptInput {
  run: Run
  profile: ProjectProfile
  candidates: readonly CandidatePlan[]
  critique: PlanCritiqueOutput | null
  /** Repository facts selected for the request (non-stale). */
  facts: readonly RepositoryFact[]
  previousErrors?: string[]
}

export function buildSynthesizerPrompt(input: SynthesizerPromptInput): Pack {
  const critique = input.critique
    ? [
        `Summary: ${input.critique.summary}`,
        `Preferred candidate: ${input.critique.preferredCandidate}`,
        input.critique.findings.length > 0
          ? boundedList(
              input.critique.findings.map(
                (f) => `- [${f.severity}] ${f.candidate}: ${f.issue}${f.recommendation ? ` Recommendation: ${f.recommendation}` : ''}`,
              ),
              SECTION_LIMITS.findings,
              'critique findings',
            )
          : 'No findings.',
      ].join('\n')
    : 'No critique is available; judge the candidates yourself.'
  const facts = input.facts.length
    ? boundedList(
        input.facts.map((f) => `- [${f.kind}] ${f.subject}: ${f.statement}`),
        SECTION_LIMITS.facts,
        'repository facts',
      )
    : null
  const errors = input.previousErrors?.length
    ? `The previous synthesized plan was rejected for these reasons. Fix every one:\n${bullets(input.previousErrors)}`
    : null
  return assemble([
    { name: 'Request', body: truncate(input.run.prompt, SECTION_LIMITS.request) },
    { name: 'Mode', body: MODE_GUIDANCE[input.run.mode] },
    { name: 'Project profile', body: renderProfile(input.profile) },
    { name: 'Repository constraints', body: facts },
    { name: 'Candidate plans', body: renderCandidates(input.candidates) },
    { name: 'Critique', body: critique },
    { name: 'Plan validation errors', body: errors },
    {
      name: 'Instructions',
      body: 'Produce the single final MissionPlan: start from the preferred candidate, fix the critique findings, drop duplicated or conflicting tasks, and respect the repository constraints. Return only the MissionPlan.',
    },
  ])
}

// ───────────────────────────── finding arbitration ─────────────────────────────

export interface ArbiterPromptInput {
  task: TaskSpec
  findings: readonly DedupedFinding[]
  diffStat: string
  patch: string
}

/** The arbiter gets the deduplicated findings with indexes and the diff, and rules on each index. */
export function buildArbiterPrompt(input: ArbiterPromptInput): Pack {
  const findings = input.findings.map((d, i) => `[${i}] (reported by ${d.reportedBy.join(', ')})\n${renderFinding(d.finding)}`)
  return assemble([
    { name: 'Requirements', body: renderTaskSpec(input.task) },
    { name: 'Acceptance criteria', body: criteriaSection(input.task, []) },
    { name: 'Findings to arbitrate', body: boundedList(findings, SECTION_LIMITS.findings, 'findings') },
    { name: 'Diff summary', body: truncate(input.diffStat, SECTION_LIMITS.diffStat) },
    { name: 'Patch', body: input.patch.trim() ? truncate(input.patch, SECTION_LIMITS.patch) : null },
    {
      name: 'Instructions',
      body: 'Decide every finding by its index: read the code it refers to, confirm or refute it, and return one decision per index with accepted true or false and a reason. Only critical and high findings can block the change, so be strict about them.',
    },
  ])
}
