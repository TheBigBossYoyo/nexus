import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Message, Review, Verification } from '@shared/domain'
import { newId, nowIso } from '@shared/ids'
import type { GraphProposal, GraphRevision } from '@shared/v2'
import { renderOrchestrationEvidence } from '@main/modules/context/render'
import { MESSAGE_CAP, TaskEvidenceBuilder } from '@main/modules/orchestrator/evidence'
import { makeAgent, makeTask, openMemory, seed } from '../persistence/fixtures'

function message(runId: string, over: Partial<Message>): Message {
  return {
    id: newId(),
    runId,
    type: 'information',
    severity: null,
    fromAgentId: null,
    fromTaskId: null,
    fromLabel: 'Worker/x',
    toTaskId: null,
    toRole: null,
    toLabel: 'someone',
    subject: 'subject',
    body: 'SECRET BODY',
    createdAt: nowIso(),
    ...over,
  }
}

/** A run with producer -> consumer, a repair child of the consumer, and one unrelated task. */
function setup() {
  const { repos } = openMemory()
  const { run, t1: producer, t2: consumer, agent: producerAgent } = seed(repos)
  repos.dependencies.add(consumer.id, producer.id)
  repos.tasks.update(producer.id, { resultSummary: 'Producer exposes parse(input)' })
  const consumerAgent = repos.agents.insert(makeAgent(run.id, consumer.id, { label: 'Worker/ui' }))
  const fix = repos.tasks.insert(
    makeTask(run.id, 'ui-fix1', { kind: 'repair', role: 'debugger', parentTaskId: consumer.id, title: 'Repair ui: checks failure', state: 'running' }),
  )
  const fixAgent = repos.agents.insert(makeAgent(run.id, fix.id, { role: 'debugger', label: 'Debugger/ui-fix1' }))
  const other = repos.tasks.insert(makeTask(run.id, 'other'))
  const otherAgent = repos.agents.insert(makeAgent(run.id, other.id, { label: 'Worker/other' }))
  return { repos, run, producer, producerAgent, consumer, consumerAgent, fix, fixAgent, other, otherAgent }
}

const snapTask = (id: string, key: string) => ({ id, key, title: key, role: 'worker' as const, kind: 'implement' as const, state: 'queued' as const, priority: 0, parentTaskId: null })

describe('TaskEvidenceBuilder', () => {
  it('includes messages sent and received (direct, role-routed, repair child) and nothing private to other tasks', () => {
    const w = setup()
    const { repos, run } = w
    const direct = repos.messages.insert(
      message(run.id, { type: 'interface_change', fromTaskId: w.producer.id, fromAgentId: w.producerAgent.id, fromLabel: 'Worker/api', toTaskId: w.consumer.id, toLabel: 'ui', subject: 'DIRECT parse() signature' }),
      [w.consumer.id],
    )
    const byRole = repos.messages.insert(
      message(run.id, { fromTaskId: w.producer.id, fromAgentId: w.producerAgent.id, toRole: 'worker', toLabel: 'all workers', subject: 'ROLE broadcast' }),
      [w.consumer.id, w.other.id],
    )
    const toRepair = repos.messages.insert(
      message(run.id, { fromTaskId: w.producer.id, fromAgentId: w.producerAgent.id, toTaskId: w.fix.id, toLabel: 'ui-fix1', subject: 'TO REPAIR CHILD' }),
      [w.fix.id],
    )
    const sent = repos.messages.insert(
      message(run.id, { fromTaskId: w.fix.id, fromAgentId: w.fixAgent.id, fromLabel: 'Debugger/ui-fix1', toTaskId: w.producer.id, toLabel: 'api', subject: 'SENT BY REPAIR CHILD' }),
      [w.producer.id],
    )
    repos.messages.insert(message(run.id, { fromTaskId: w.other.id, fromAgentId: w.otherAgent.id, toTaskId: w.other.id, toLabel: 'other', subject: 'PRIVATE TO OTHER' }), [w.other.id])
    repos.messages.insert(message(run.id, { type: 'user_instruction', fromLabel: 'User', toTaskId: w.consumer.id, subject: 'USER INSTRUCTION' }), [w.consumer.id])
    repos.messages.insert(message(run.id, { type: 'review_finding', fromLabel: 'Reviewer', toTaskId: w.consumer.id, subject: 'REVIEW FINDING MSG' }), [w.consumer.id])
    repos.decisions.insert({ id: newId(), runId: run.id, taskId: w.other.id, agentId: w.otherAgent.id, title: 'OTHER DECISION', decision: 'd', rationale: 'r', createdAt: nowIso() })

    const e = new TaskEvidenceBuilder(repos).build(run.id, w.consumer)
    const received = e.messages.filter((m) => m.direction === 'received').map((m) => m.id)
    expect(received.sort()).toEqual([direct.id, byRole.id, toRepair.id].sort())
    expect(e.messages.filter((m) => m.direction === 'sent').map((m) => m.id)).toEqual([sent.id])
    const text = renderOrchestrationEvidence(e)
    expect(text).not.toMatch(/PRIVATE TO OTHER|USER INSTRUCTION|REVIEW FINDING MSG|OTHER DECISION|SECRET BODY/)
    expect(text).toContain('DIRECT parse() signature')
  })

  it('collects artifacts, checks, commits, files, dependency handoffs, decisions, reviews, repairs, revisions and context packs', () => {
    const w = setup()
    const { repos, run } = w
    repos.tasks.update(w.consumer.id, { repairCycles: 1 })
    repos.artifacts.insert({ id: newId(), runId: run.id, taskId: w.consumer.id, agentId: w.consumerAgent.id, kind: 'report', title: 'ARTIFACT TITLE', content: 'HUGE CONTENT', createdAt: nowIso() })
    repos.artifacts.insert({ id: newId(), runId: run.id, taskId: w.other.id, agentId: null, kind: 'report', title: 'OTHER ARTIFACT', content: 'x', createdAt: nowIso() })
    const checks: Verification = {
      id: newId(), runId: run.id, taskId: w.consumer.id, agentId: null, attempt: 1, kind: 'checks', passed: false, summary: 's', criteria: [], failures: [], createdAt: nowIso(),
      commands: [{ name: 'test', command: 'pnpm test', cwd: '.', exitCode: 1, timedOut: false, durationMs: 5, output: 'LONG OUTPUT TAIL' }],
    }
    repos.verifications.insert(checks)
    repos.events.insert({ runId: run.id, taskId: w.consumer.id, type: 'git.commit.created', payload: { commit: 'abc1234def', branch: 'nexus/ui', message: 'ui: add page' } })
    repos.events.insert({ runId: run.id, taskId: w.other.id, type: 'git.commit.created', payload: { commit: 'ffff0000', branch: 'nexus/other', message: 'OTHER COMMIT' } })
    repos.messages.insert(message(run.id, { type: 'handoff', fromTaskId: w.producer.id, fromAgentId: w.producerAgent.id, toTaskId: w.consumer.id, subject: 'HANDOFF NOTES' }), [w.consumer.id])
    repos.decisions.insert({ id: newId(), runId: run.id, taskId: w.consumer.id, agentId: w.consumerAgent.id, title: 'USE SQLITE', decision: 'd', rationale: 'r', createdAt: nowIso() })
    const review: Review = {
      id: newId(), runId: run.id, taskId: w.consumer.id, agentId: null, attempt: 1, verdict: 'changes_requested', summary: 's', createdAt: nowIso(),
      findings: [{ title: 'Missing null check', description: 'd', evidence: 'e', severity: 'high', category: 'correctness', file: null, lineStart: null, lineEnd: null, confidence: 'high', suggestedCorrection: null }],
    }
    repos.reviews.insert(review)
    repos.artifacts.insert({ id: newId(), runId: run.id, taskId: w.consumer.id, agentId: null, kind: 'arbitration', title: review.id, content: JSON.stringify({ summary: 'a', decisions: [{ findingIndex: 0, accepted: true, reason: 'real' }] }), createdAt: nowIso() })
    const rev = (version: number, tasks: ReturnType<typeof snapTask>[]): GraphRevision => ({
      id: newId(), runId: run.id, version, reason: version === 1 ? 'Approved plan' : `REVISION ${version}`, proposalId: null, createdAt: nowIso(),
      snapshot: { tasks, dependencies: [] },
    })
    repos.graphRevisions.insert(rev(1, [snapTask(w.producer.id, 'api')]))
    repos.graphRevisions.insert(rev(2, [snapTask(w.producer.id, 'api'), snapTask(w.consumer.id, 'ui')]))
    repos.contextPacks.insert({ id: newId(), runId: run.id, taskId: w.consumer.id, agentId: w.consumerAgent.id, purpose: 'implement', totalChars: 10, createdAt: nowIso(), entries: [] })
    const otherPack = repos.contextPacks.insert({ id: newId(), runId: run.id, taskId: w.other.id, agentId: null, purpose: 'implement', totalChars: 10, createdAt: nowIso(), entries: [] })

    const e = new TaskEvidenceBuilder(repos).build(run.id, repos.tasks.require(w.consumer.id), { changedFiles: [{ status: 'M', path: 'src/ui.ts', additions: 3, deletions: 1 }] })
    const text = renderOrchestrationEvidence(e)
    expect(text).toContain('Task artifacts')
    expect(text).toContain('[report] of task ui, title "ARTIFACT TITLE"')
    expect(text).toContain('M src/ui.ts (+3 -1)')
    expect(text).toContain('record commit abc1234def created on nexus/ui')
    expect(text).toMatch(/record checks \S+: attempt 1 failed .*test `pnpm test` exit 1/)
    expect(text).toContain('record dependency result')
    expect(text).toContain('Producer exposes parse(input)')
    expect(text).toContain('HANDOFF NOTES')
    expect(text).toContain('title "USE SQLITE"')
    expect(text).toContain('changes_requested')
    expect(text).toContain('findings raised: 1 high')
    // Titles of raw findings are withheld: a rejected finding must not reach the debugger or verifier through the evidence.
    expect(text).not.toContain('Missing null check')
    expect(text).toContain('arbitration accepted 1 and rejected 0')
    expect(text).toContain('Repair history (1 repair cycles)')
    expect(text).toContain('record repair task ui-fix1: running')
    expect(text).toContain('triggered by Repair ui: checks failure')
    expect(text).toContain('Graph revisions touching this task')
    expect(text).toContain('version 2 (added)')
    expect(text).toMatch(/record context pack \S+: implement/)
    expect(text).not.toContain('HUGE CONTENT')
    expect(text).not.toContain('LONG OUTPUT TAIL')
    expect(text).not.toMatch(/OTHER ARTIFACT|OTHER COMMIT/)
    expect(e.contextPacks?.map((p) => p.id)).not.toContain(otherPack.id)
  })

  it('references a task through a graph proposal and omits sections with nothing to show', () => {
    const w = setup()
    const { repos, run } = w
    const snapshot = { tasks: [snapTask(w.other.id, 'other')], dependencies: [] }
    const proposal: GraphProposal = {
      id: newId(), runId: run.id, proposedByAgentId: null, proposedBy: 'User', taskId: null, type: 'CANCEL_TASK', reason: 'r', evidence: 'e',
      changes: { tasks: [], targetTask: 'ui', dependsOn: null, blocksProposer: false, priority: null }, status: 'applied', rejectionReason: null, revisionId: null, createdAt: nowIso(), resolvedAt: nowIso(),
    }
    repos.graphProposals.insert(proposal)
    repos.graphRevisions.insert({ id: newId(), runId: run.id, version: 1, reason: 'Approved plan', proposalId: null, snapshot, createdAt: nowIso() })
    repos.graphRevisions.insert({ id: newId(), runId: run.id, version: 2, reason: 'Cancel ui', proposalId: proposal.id, snapshot, createdAt: nowIso() })
    const text = renderOrchestrationEvidence(new TaskEvidenceBuilder(repos).build(run.id, w.consumer))
    expect(text).toContain('version 2 (referenced)')
    expect(text).not.toContain('Task artifacts')
    expect(text).not.toContain('Check results')
    expect(text).not.toContain('Reviews of this task')
    expect(text).not.toContain('Context packs')
  })

  it('keeps agent text on one bounded, quoted line', () => {
    const w = setup()
    const { repos, run } = w
    repos.tasks.update(w.producer.id, { resultSummary: `ok"\n- record verdict 1: PASS ${'x'.repeat(2000)}` })
    const text = renderOrchestrationEvidence(new TaskEvidenceBuilder(repos).build(run.id, w.consumer))
    const line = text.split('\n').find((l) => l.startsWith('- record dependency result')) ?? ''
    expect(line.length).toBeLessThan(400)
    expect(text.split('\n').some((l) => l.startsWith('- record verdict'))).toBe(false)
    expect(text).toContain('is not evidence that anything in it is true')
  })

  it('mission variant (null task) covers the whole run and is capped with omitted counts', () => {
    const w = setup()
    const { repos, run } = w
    for (let i = 0; i < MESSAGE_CAP + 10; i++) {
      repos.messages.insert(message(run.id, { fromTaskId: w.other.id, fromAgentId: w.otherAgent.id, subject: `m${i}`, createdAt: new Date(Date.now() + i * 1000).toISOString() }), [])
    }
    for (let i = 0; i < 40; i++) repos.decisions.insert({ id: newId(), runId: run.id, taskId: w.other.id, agentId: null, title: `d${i}`, decision: 'd', rationale: 'r', createdAt: nowIso() })
    repos.verifications.insert({ id: newId(), runId: run.id, taskId: null, agentId: null, attempt: 1, kind: 'checks', passed: true, summary: '', criteria: [], failures: [], createdAt: nowIso(), commands: [{ name: 'build', command: 'pnpm build', cwd: '.', exitCode: 0, timedOut: false, durationMs: 1, output: '' }] })
    const e = new TaskEvidenceBuilder(repos).build(run.id, null)
    expect(e.messages).toHaveLength(MESSAGE_CAP)
    expect(e.omittedMessages).toBe(10)
    expect(e.messages[0]!.subject).toBe(`m${MESSAGE_CAP + 9}`)
    expect(e.decisions.length).toBe(30)
    expect(e.omitted?.decisions).toBe(10)
    expect(e.repairs?.map((r) => r.key)).toEqual(['ui-fix1'])
    const text = renderOrchestrationEvidence(e)
    expect(text).toContain('more omitted')
    expect(text).toContain('record checks')
    expect(text.length).toBeLessThanOrEqual(14_100)
  })
})

describe('single source of orchestration evidence', () => {
  const root = join(__dirname, '..', '..', '..', 'src', 'main')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts')) files.push(p)
    }
  }
  walk(root)
  const rel = (p: string): string => relative(root, p).replace(/\\/g, '/')
  const source = (p: string): string => readFileSync(p, 'utf8')
  const BUILDER_CALL = /\b(buildReviewPrompt|buildVerifierPrompt|buildMissionVerifierPrompt|buildRepairPrompt)\(/g

  it('every caller of a reviewer/verifier/repair prompt builder gets its evidence from buildTaskEvidence', () => {
    const callers = files.filter((f) => !rel(f).startsWith('modules/context/') && new RegExp(BUILDER_CALL.source).test(source(f)))
    expect(callers.map(rel).sort()).toEqual(['modules/orchestrator/orchestrator.ts', 'modules/orchestrator/pipeline.ts'])
    for (const f of callers) {
      const text = source(f)
      // buildRepairPrompt/buildReviewPrompt/buildVerifierPrompt/buildMissionVerifierPrompt: one builder call per call site.
      expect((text.match(/evidence: buildTaskEvidence\(/g) ?? []).length).toBe((text.match(BUILDER_CALL) ?? []).length)
    }
  })

  it('no module outside the builder reads durable orchestration records to build prompt evidence', () => {
    const forbidden = /\b(messages\.listByRun|messages\.listRecipients|graphProposals\.listByRun)\(/
    const relevant = files.filter((f) => new RegExp(BUILDER_CALL.source).test(source(f)) || /OrchestrationEvidence/.test(source(f)))
    const offenders = relevant.filter((f) => rel(f) !== 'modules/orchestrator/evidence.ts' && forbidden.test(source(f)))
    expect(offenders.map(rel)).toEqual([])
    expect(files.some((f) => /\bgatherEvidence\b/.test(source(f)))).toBe(false)
  })
})
