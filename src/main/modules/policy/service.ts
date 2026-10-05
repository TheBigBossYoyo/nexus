import type { Preset, Project, Run } from '@shared/domain'
import type { PushMessage } from '@shared/events'
import { newId } from '@shared/ids'
import { errorMessage } from '@shared/result'
import type { Settings } from '@shared/settings'
import {
  DEFAULT_POLICY_CONFIG,
  contextKeyOf,
  type ConcreteStrategy,
  type EvidenceLabel,
  type MissionOutcome,
  type MissionTerminal,
  type PolicyConfig,
  type PolicyDecision,
  type PolicyPointer,
  type PolicyPromotion,
  type PolicySnapshot,
  type RunStrategyInfo,
  type Strategy,
  type TaskProfile,
  type UsageStatus,
} from '@shared/v3'
import type {
  LearnResult,
  PolicyContextRow,
  PolicyDiff,
  PolicyOverview,
  PolicyPreview,
  RunPolicyInfo,
} from '@shared/v3-read'
import type { Repositories } from '@main/modules/persistence'
import { configureStrategy, type StrategyPlan } from '@main/modules/strategy/strategies'
import { defaultStrategy } from './defaults'
import { decide } from './engine'
import {
  POLICY_THRESHOLDS,
  aggregateEvidence,
  compareSentence,
  proposeCandidates,
  rowsAt,
  shadowEvaluate,
  summarize,
  type EvidenceTrial,
} from './learning'
import { profileTask, type ProfilerInput } from './profiler'
import { applyConfig, applyPromotion, baseStrategyFor, diffSnapshots, preferenceFor, summarizeSnapshot } from './snapshots'

export const POLICY_POINTER_KEY = 'policy-pointer'
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

export interface PolicyServiceDeps {
  repos: Repositories
  now?: () => number
  nexusVersion: string
  usage?: { status(): UsageStatus; recentLimitWithin(ms: number): boolean }
  push?: (m: PushMessage) => void
  /** Source of exploration seeds (stored on every decision that explores or could have). */
  seed?: () => number
}

export interface DecideForRunInput {
  project: Project
  prompt: string
  runId: string
  preset: Preset
  requested: Strategy
  candidates?: number
  arenaTrialId?: string | null
  user?: ProfilerInput['user']
}

export interface DecideForRunResult {
  profile: TaskProfile
  decision: PolicyDecision | null
  plan: StrategyPlan
  info: RunStrategyInfo
}

const LABEL_RANK: EvidenceLabel[] = ['INSUFFICIENT', 'WEAK', 'MODERATE', 'STRONG']

export class PolicyService {
  private readonly repos: Repositories
  private readonly clock: () => number
  private readonly drawSeed: () => number

  constructor(private readonly deps: PolicyServiceDeps) {
    this.repos = deps.repos
    this.clock = deps.now ?? Date.now
    this.drawSeed = deps.seed ?? (() => Math.floor(Math.random() * 0x1_0000_0000))
  }

  private iso(): string {
    return new Date(this.clock()).toISOString()
  }

  private notify(): void {
    this.deps.push?.({ kind: 'policy' })
  }

  // ───────────────────────────── snapshots and pointer ─────────────────────────────

  private routing(settings: Settings = this.repos.settings.get()): Record<string, string> {
    return { ...settings.models.tiers }
  }

  /** Writes snapshot version 1 and the pointer when they are missing. Idempotent; returns version 1. */
  ensureDefault(): PolicySnapshot {
    const existing = this.repos.policySnapshots.list()
    let first = existing[existing.length - 1] ?? null
    if (!first) {
      first = this.repos.policySnapshots.insert({
        id: newId(),
        version: 1,
        createdAt: this.iso(),
        origin: 'default',
        parentId: null,
        preferences: [],
        config: { ...DEFAULT_POLICY_CONFIG },
        routing: this.routing(),
        note: 'Built-in default policy',
      })
    }
    const pointer = this.repos.settings.getValue<PolicyPointer>(POLICY_POINTER_KEY)
    if (!pointer || !this.repos.policySnapshots.get(pointer.activeId)) {
      const latest = this.repos.policySnapshots.list()[0] ?? first
      this.writePointer({ activeId: latest.id, previousId: null, pinnedId: null })
    }
    return first
  }

  private writePointer(p: PolicyPointer): void {
    this.repos.settings.setValue(POLICY_POINTER_KEY, p)
  }

  pointer(): PolicyPointer {
    this.ensureDefault()
    const p = this.repos.settings.getValue<PolicyPointer>(POLICY_POINTER_KEY)!
    // A pin that points at a missing snapshot is ignored rather than trusted.
    return { activeId: p.activeId, previousId: p.previousId ?? null, pinnedId: p.pinnedId && this.repos.policySnapshots.get(p.pinnedId) ? p.pinnedId : null }
  }

  /** The snapshot new decisions use: the pinned one if any, else the promoted one. */
  active(): PolicySnapshot {
    const p = this.pointer()
    return this.repos.policySnapshots.require(p.pinnedId ?? p.activeId)
  }

  /** The snapshot a promotion builds on: the pointer's active one, even while another is pinned. */
  private head(): PolicySnapshot {
    return this.repos.policySnapshots.require(this.pointer().activeId)
  }

  snapshot(id: string): PolicySnapshot | null {
    return this.repos.policySnapshots.get(id)
  }

  compare(a: string, b: string): PolicyDiff {
    return diffSnapshots(this.repos.policySnapshots.require(a), this.repos.policySnapshots.require(b))
  }

  decisions(page: { limit?: number; offset?: number } = {}): PolicyDecision[] {
    return this.repos.policyDecisions.listRecent(page)
  }

  // ───────────────────────────── overview ─────────────────────────────

  overview(): PolicyOverview {
    const active = this.active()
    const stats = this.repos.strategyStatistics.list()
    const keys = [...new Set([...stats.map((s) => s.contextKey), ...active.preferences.map((p) => p.contextKey)])]
      .filter((k) => k !== '*|*|*')
      .sort()
    const contexts: PolicyContextRow[] = keys.map((contextKey) => {
      const level = rowsAt(stats, contextKey)
      const summary = summarize(stats, contextKey)
      const preference = preferenceFor(active, contextKey)
      const best = summary.rows.reduce<EvidenceLabel>(
        (acc, r) => (LABEL_RANK.indexOf(r.label) > LABEL_RANK.indexOf(acc) ? r.label : acc),
        'INSUFFICIENT',
      )
      const preferred = baseStrategyFor(active, contextKey)
      const chosen = summary.rows.find((r) => r.strategy === preferred) ?? null
      const other = summary.rows.filter((r) => r.strategy !== preferred && r.effectiveN > 0).sort((a, b) => b.effectiveN - a.effectiveN)[0] ?? null
      return {
        contextKey,
        defaultStrategy: defaultStrategy(contextKey),
        preferred,
        preference,
        arenaTrials: level.reduce((a, r) => a + r.arenaN, 0),
        missions: level.reduce((a, r) => a + r.missionN, 0),
        label: best,
        reason: preference
          ? preference.reason
          : chosen
            ? compareSentence(summary.evidenceContextKey ?? contextKey, chosen, other)
            : 'No evidence yet; the default policy applies.',
        rows: summary.rows,
      }
    })
    return {
      active,
      pointer: this.pointer(),
      evidence: {
        arenaTrials: this.repos.arenaTrials.count(),
        arenaCampaigns: this.repos.arenaCampaigns.count(),
        missions: this.repos.missionOutcomes.countMissions(),
        computedAt: stats[0]?.computedAt ?? null,
      },
      contexts,
      candidates: this.repos.policyCandidates.listRecent(100),
      history: this.repos.policyPromotions.listRecent(100),
      snapshots: this.repos.policySnapshots.list().map(summarizeSnapshot),
    }
  }

  // ───────────────────────────── learning ─────────────────────────────

  /** Role → model the tiers resolve to now, from settings. */
  currentModels(settings: Settings = this.repos.settings.get()): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [role, tier] of Object.entries(settings.models.rolePolicy)) {
      const model = settings.models.tiers[tier as keyof Settings['models']['tiers']]
      if (model) out[role] = model
    }
    return out
  }

  private contextOfTrial(trial: { taskProfileId: string | null; caseVersionId: string }): string | null {
    if (trial.taskProfileId) {
      const profile = this.repos.taskProfiles.get(trial.taskProfileId)
      if (profile) return profile.contextKey
    }
    const version = this.repos.arenaCaseVersions.get(trial.caseVersionId)
    if (!version) return null
    const d = version.definition
    return contextKeyOf(d.category, d.complexity, d.risk)
  }

  /** Recompute the statistics and propose candidates. Nothing about the active policy changes. */
  learn(): LearnResult {
    // Candidates are judged against the pointer's active snapshot, not a pinned one: promotion builds on the head.
    const active = this.head()
    const settings = this.repos.settings.get()
    const now = this.clock()
    const since = new Date(now - active.config.evidenceWindowDays * DAY_MS).toISOString()

    const finished = this.repos.arenaTrials.listFinishedSince(since)
    const metrics = new Map(this.repos.arenaMetrics.listByTrials(finished.map((t) => t.id)).map((m) => [m.trialId, m]))
    const trials: EvidenceTrial[] = []
    for (const t of finished) {
      const contextKey = this.contextOfTrial(t)
      if (contextKey) trials.push({ ...t, metrics: metrics.get(t.id) ?? null, contextKey })
    }
    const outcomes = this.repos.missionOutcomes.listMissionsSince(since)
    const stats = aggregateEvidence({ trials, outcomes, config: active.config, now, currentModels: this.currentModels(settings) })

    const contexts = [...new Set(stats.map((s) => s.contextKey))].filter((k) => k !== '*|*|*')
    const { candidates: allProposed, notes } = proposeCandidates({ stats, active, knownContexts: contexts, now })
    // A rejected proposal comes back only when its challenger has gained enough new controlled evidence.
    const history = this.repos.policyCandidates.listRecent(500)
    const proposed = allProposed.filter((c) => {
      const last = history.find((h) => h.contextKey === c.contextKey && h.fromStrategy === c.fromStrategy && h.toStrategy === c.toStrategy)
      if (!last || last.status !== 'rejected' || last.baseSnapshotId !== c.baseSnapshotId) return true
      if (c.arenaTrials >= last.arenaTrials + POLICY_THRESHOLDS.reproposeAfterArenaTrials) return true
      notes.push(`${c.contextKey}: ${c.toStrategy} over ${c.fromStrategy} was rejected on this policy; it is proposed again after ${POLICY_THRESHOLDS.reproposeAfterArenaTrials} more Arena trials (now ${c.arenaTrials}, was ${last.arenaTrials} when rejected).`)
      return false
    })
    const profiles = this.repos.taskProfiles.listRecent(500)
    const allOutcomes = this.repos.missionOutcomes.listRecent({ limit: 500 })

    this.repos.transaction(() => {
      this.repos.strategyStatistics.replaceAll(stats)
      const existing = this.repos.policyCandidates.listByStatus('proposed')
      const keep = new Set<string>()
      for (const c of proposed) {
        const same = existing.find(
          (e) =>
            e.contextKey === c.contextKey &&
            e.fromStrategy === c.fromStrategy &&
            e.toStrategy === c.toStrategy &&
            e.baseSnapshotId === c.baseSnapshotId &&
            e.arenaTrials === c.arenaTrials &&
            e.missions === c.missions &&
            e.label === c.label,
        )
        if (same) {
          keep.add(same.id)
          continue
        }
        const row = this.repos.policyCandidates.insert({ ...c, shadow: shadowEvaluate(c, profiles, allOutcomes, active) })
        keep.add(row.id)
      }
      // Everything else that was proposed is out of date: a newer one replaced it, the base moved, or the evidence no longer supports it.
      for (const e of existing) {
        if (!keep.has(e.id)) this.repos.policyCandidates.update(e.id, { status: 'superseded', resolvedAt: this.iso() })
      }
    })
    this.notify()
    return { statistics: stats.length, candidates: this.repos.policyCandidates.listByStatus('proposed'), notes }
  }

  // ───────────────────────────── user actions ─────────────────────────────

  private record(
    action: PolicyPromotion['action'],
    to: string,
    from: string | null,
    candidateId: string | null,
    note: string | null,
  ): void {
    this.repos.policyPromotions.insert({
      id: newId(),
      action,
      candidateId,
      fromSnapshotId: from,
      toSnapshotId: to,
      by: 'user',
      note,
      createdAt: this.iso(),
    })
  }

  promote(candidateId: string): PolicyOverview {
    const candidate = this.repos.policyCandidates.require(candidateId)
    if (candidate.status !== 'proposed') throw new Error(`Candidate is ${candidate.status}, not proposed`)
    if (candidate.baseSnapshotId !== this.head().id) throw new Error('stale candidate: run learn again')
    this.repos.transaction(() => {
      const base = this.head()
      const pointer = this.pointer()
      const next = this.repos.policySnapshots.insert(
        applyPromotion(base, candidate, {
          id: newId(),
          version: this.repos.policySnapshots.latestVersion() + 1,
          now: this.iso(),
          routing: this.routing(),
        }),
      )
      this.writePointer({ activeId: next.id, previousId: base.id, pinnedId: pointer.pinnedId })
      this.repos.policyCandidates.update(candidate.id, { status: 'promoted', resolvedAt: this.iso() })
      this.record('promote', next.id, base.id, candidate.id, next.note)
    })
    this.notify()
    return this.overview()
  }

  reject(candidateId: string): PolicyOverview {
    const candidate = this.repos.policyCandidates.require(candidateId)
    if (candidate.status !== 'proposed') throw new Error(`Candidate is ${candidate.status}, not proposed`)
    this.repos.transaction(() => {
      this.repos.policyCandidates.update(candidate.id, { status: 'rejected', resolvedAt: this.iso() })
      const head = this.pointer().activeId
      this.record('reject', head, head, candidate.id, `Rejected ${candidate.toStrategy} for ${candidate.contextKey}`)
    })
    this.notify()
    return this.overview()
  }

  /** One step back: the previous snapshot becomes active. Only future decisions change. */
  rollback(): PolicyOverview {
    const pointer = this.pointer()
    if (!pointer.previousId || !this.repos.policySnapshots.get(pointer.previousId)) throw new Error('There is no earlier snapshot to roll back to')
    this.repos.transaction(() => {
      this.writePointer({ activeId: pointer.previousId!, previousId: null, pinnedId: pointer.pinnedId })
      this.record('rollback', pointer.previousId!, pointer.activeId, null, 'Rolled back one step')
    })
    this.notify()
    return this.overview()
  }

  pin(snapshotId: string | null): PolicyOverview {
    const pointer = this.pointer()
    if (snapshotId !== null) this.repos.policySnapshots.require(snapshotId)
    this.repos.transaction(() => {
      this.writePointer({ ...pointer, pinnedId: snapshotId })
      if (snapshotId !== null) this.record('pin', snapshotId, pointer.pinnedId ?? pointer.activeId, null, 'Pinned')
      else this.record('unpin', pointer.activeId, pointer.pinnedId, null, 'Unpinned')
    })
    this.notify()
    return this.overview()
  }

  setConfig(patch: Partial<Pick<PolicyConfig, 'exploration' | 'speculation'>>): PolicyOverview {
    const base = this.head()
    const changes: Partial<PolicyConfig> = {}
    if (patch.exploration !== undefined && patch.exploration !== base.config.exploration) changes.exploration = patch.exploration
    if (patch.speculation !== undefined && patch.speculation !== base.config.speculation) changes.speculation = patch.speculation
    if (Object.keys(changes).length === 0) return this.overview()
    const pointer = this.pointer()
    this.repos.transaction(() => {
      const note = Object.entries(changes)
        .map(([k, v]) => `${k}: ${String(base.config[k as keyof PolicyConfig])} -> ${String(v)}`)
        .join('; ')
      const next = this.repos.policySnapshots.insert(
        applyConfig(base, changes, {
          id: newId(),
          version: this.repos.policySnapshots.latestVersion() + 1,
          now: this.iso(),
          routing: this.routing(),
          note,
        }),
      )
      this.writePointer({ activeId: next.id, previousId: base.id, pinnedId: pointer.pinnedId })
      this.record('config', next.id, base.id, null, note)
    })
    this.notify()
    return this.overview()
  }

  // ───────────────────────────── decisions ─────────────────────────────

  private usageNow(): { status: UsageStatus; recentLimit: boolean; note?: string } {
    const u = this.deps.usage
    if (!u) return { status: 'AVAILABLE', recentLimit: false }
    try {
      return { status: u.status(), recentLimit: u.recentLimitWithin(HOUR_MS) }
    } catch (e) {
      // An unreadable usage service must not stop a run from being created, but nothing is known about availability:
      // treat it as unavailable (no SPECULATIVE, no SWARM) and say so in the decision.
      return {
        status: 'RUNTIME_UNAVAILABLE',
        recentLimit: false,
        note: `The usage service could not be read (${errorMessage(e)}); availability is treated as unknown, so no SPECULATIVE or SWARM.`,
      }
    }
  }

  private profileFor(project: Project, prompt: string, ids: ProfilerInput['ids'], user?: ProfilerInput['user']): TaskProfile {
    const facts = this.repos.facts.listByProject(project.id)
    return profileTask({ prompt, profile: project.profile, facts, user, ids })
  }

  /** What an ADAPTIVE mission would do right now. Nothing is stored. */
  preview(input: { projectId: string; prompt: string }): PolicyPreview {
    const project = this.repos.projects.require(input.projectId)
    const settings = this.repos.settings.get()
    const profile = this.profileFor(project, input.prompt, {
      id: 'preview',
      projectId: project.id,
      runId: null,
      arenaTrialId: null,
      createdAt: this.iso(),
    })
    const usage = this.usageNow()
    const decision = decide({
      profile,
      snapshot: this.active(),
      stats: this.repos.strategyStatistics.list(),
      seed: this.drawSeed(),
      usageStatus: usage.status,
      recentLimit: usage.recentLimit,
      usageNote: usage.note,
      preset: settings.execution.defaultPreset,
      settings,
      id: 'preview',
      now: this.clock(),
    })
    return { profile, decision }
  }

  /**
   * Profile the task (always stored) and, for ADAPTIVE, decide and store the decision. A concrete strategy
   * returns that strategy's plan unchanged; the snapshot id is recorded either way so every mission names
   * the policy it ran under.
   */
  decideForRun(input: DecideForRunInput): DecideForRunResult {
    const settings = this.repos.settings.get()
    const snapshot = this.active()
    const profile = this.repos.taskProfiles.insert(
      this.profileFor(
        input.project,
        input.prompt,
        { id: newId(), projectId: input.project.id, runId: input.runId, arenaTrialId: input.arenaTrialId ?? null, createdAt: this.iso() },
        input.user,
      ),
    )
    let decision: PolicyDecision | null = null
    let resolved: ConcreteStrategy
    let plan: StrategyPlan
    if (input.requested === 'ADAPTIVE') {
      const usage = this.usageNow()
      decision = this.repos.policyDecisions.insert(
        decide({
          profile,
          snapshot,
          stats: this.repos.strategyStatistics.list(),
          seed: this.drawSeed(),
          usageStatus: usage.status,
          recentLimit: usage.recentLimit,
          usageNote: usage.note,
          preset: input.preset,
          settings,
          candidates: input.candidates,
          id: newId(),
          now: this.clock(),
        }),
      )
      resolved = decision.strategy
      plan = { ...configureStrategy(resolved, { preset: input.preset, settings, candidates: input.candidates }), maxParallelAgents: decision.workerCount }
    } else {
      resolved = input.requested
      plan = configureStrategy(resolved, { preset: input.preset, settings, candidates: input.candidates })
    }
    const info: RunStrategyInfo = {
      requested: input.requested,
      resolved,
      speculativeCandidates: plan.speculativeCandidates,
      policyDecisionId: decision?.id ?? null,
      policySnapshotId: snapshot.id,
      taskProfileId: profile.id,
      arenaTrialId: input.arenaTrialId ?? null,
    }
    return { profile, decision, plan, info }
  }

  // ───────────────────────────── outcomes ─────────────────────────────

  /**
   * Build the observational outcome of a run from durable rows. Called when a run reaches a terminal state
   * or pauses for an intervention. Upserts by run, flags Arena runs, and never throws.
   */
  recordOutcome(runId: string): MissionOutcome | null {
    try {
      const run = this.repos.runs.get(runId)
      if (!run) return null
      const info = run.config.strategy
      if (!info) return null
      const terminal = this.terminalOf(run)
      if (!terminal) return null
      const profile = (info.taskProfileId ? this.repos.taskProfiles.get(info.taskProfileId) : null) ?? this.repos.taskProfiles.getByRun(runId)
      if (!profile) return null
      return this.repos.missionOutcomes.upsertForRun(this.buildOutcome(run, info, profile, terminal))
    } catch (e) {
      console.warn(`recording the mission outcome of run ${runId} failed: ${errorMessage(e)}`)
      return null
    }
  }

  private terminalOf(run: Run): MissionTerminal | null {
    if (run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled') return run.state
    if (run.state === 'paused') {
      const paused = this.repos.events.latestOfType(run.id, 'run.paused')
      if (paused?.payload.cause === 'intervention') return 'blocked'
    }
    return null
  }

  private buildOutcome(run: Run, info: RunStrategyInfo, profile: TaskProfile, terminal: MissionTerminal): MissionOutcome {
    const { repos } = this
    const now = this.clock()
    const agents = repos.agents.listByRun(run.id)
    const tasks = repos.tasks.listByRun(run.id)
    const top = tasks.filter((t) => t.parentTaskId === null)
    const repairIds = new Set(
      tasks.filter((t) => (t.parentTaskId !== null && t.kind === 'repair') || t.key.startsWith('mission-fix-')).map((t) => t.id),
    )
    const sessions = agents.reduce((a, ag) => a + repos.sessions.listByAgent(ag.id).length, 0)

    // One decision per (task, attempt): the arbiter's if a dual review was arbitrated, else "rejected if anyone rejected".
    const groups = new Map<string, { verdicts: string[]; arbitrated: string | null }>()
    for (const r of repos.reviews.listByRun(run.id)) {
      const key = `${r.taskId}\u0000${r.attempt}`
      const g = groups.get(key) ?? { verdicts: [], arbitrated: null }
      g.verdicts.push(r.verdict)
      if (r.arbitration) g.arbitrated = r.verdict
      groups.set(key, g)
    }
    const decisions = [...groups.values()].map((g) => g.arbitrated ?? (g.verdicts.includes('changes_requested') ? 'changes_requested' : 'approved'))

    const missionCriteria = repos.criteria.listByRun(run.id).filter((c) => c.taskId === null)
    let verificationPassed: boolean | null = null
    if (missionCriteria.length > 0) verificationPassed = missionCriteria.every((c) => c.status === 'passed')
    else {
      const verifier = repos.verifications.listByRun(run.id).filter((v) => v.taskId === null && v.kind === 'verifier')
      if (verifier.length > 0) verificationPassed = verifier[verifier.length - 1]!.passed
    }
    const success = terminal === 'completed' && (missionCriteria.length === 0 || verificationPassed === true)

    const active = repos.settings.getValue<{ usedMs: number; since: string | null }>(`run-active:${run.id}`)
    let elapsedMs: number | null = null
    if (active) elapsedMs = active.usedMs + (active.since ? Math.max(0, now - Date.parse(active.since)) : 0)
    else if (run.startedAt) elapsedMs = Math.max(0, (run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt))

    const reported = agents.filter((a) => a.metrics.inputTokens !== null || a.metrics.outputTokens !== null)
    const pauses = repos.quotaPauses.listByRun(run.id)
    const models: Record<string, string> = {}
    for (const a of agents) if (a.model) models[a.role] = a.model

    const resolved = info.resolved
    return {
      id: newId(),
      runId: run.id,
      projectId: run.projectId,
      taskProfileId: profile.id,
      contextKey: profile.contextKey,
      strategy: resolved,
      requestedStrategy: info.requested,
      planningMode: resolved === 'CONSENSUS' ? 'consensus' : resolved === 'SINGLE' || resolved === 'SPECULATIVE' ? 'none' : 'single',
      reviewMode: run.config.reviewMode ?? 'auto',
      policyDecisionId: info.policyDecisionId,
      policySnapshotId: info.policySnapshotId,
      models,
      agents: agents.length,
      sessions,
      tasks: top.length,
      tasksCompleted: top.filter((t) => t.state === 'completed').length,
      repairs: repairIds.size,
      reviews: decisions.length,
      reviewRejections: decisions.filter((d) => d === 'changes_requested').length,
      verificationPassed,
      elapsedMs,
      inputTokens: reported.length > 0 ? reported.reduce((a, ag) => a + (ag.metrics.inputTokens ?? 0), 0) : null,
      outputTokens: reported.length > 0 ? reported.reduce((a, ag) => a + (ag.metrics.outputTokens ?? 0), 0) : null,
      quotaPauses: pauses.length,
      quotaWaitMs: pauses.reduce((a, p) => a + Math.max(0, (p.endedAt ? Date.parse(p.endedAt) : now) - Date.parse(p.pausedAt)), 0),
      humanInterventions: repos.events.countByTypes(run.id, ['user.intervention']),
      terminal,
      success,
      // An orphan Arena run (its trial row gone) still names its trial in the run's strategy info.
      isArena: repos.arenaTrials.getByRun(run.id) !== null || Boolean(info.arenaTrialId),
      nexusVersion: this.deps.nexusVersion,
      createdAt: new Date(now).toISOString(),
    }
  }

  runInfo(runId: string): RunPolicyInfo {
    const run = this.repos.runs.get(runId)
    return {
      strategy: run?.config.strategy ?? null,
      profile: this.repos.taskProfiles.getByRun(runId),
      decision: this.repos.policyDecisions.getByRun(runId),
      outcome: this.repos.missionOutcomes.getByRun(runId),
    }
  }
}
