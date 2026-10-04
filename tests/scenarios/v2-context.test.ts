import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeScript } from '@main/modules/agent-runtime/fake-runtime'
import { fingerprintFiles } from '@main/modules/intelligence'
import { newId, nowIso } from '@shared/ids'
import type { RepositoryFact } from '@shared/v2'
import { createHarness, fileWorker, git, ipc, keyOf, plan, plannedTask, scenarioScript, sessionsOf, type Harness } from './harness'

const FILES = {
  'src/api/server.ts': 'export const server = 1\n',
  'docs/guide.md': '# guide\n',
}

async function fact(h: Harness, over: Partial<RepositoryFact> & Pick<RepositoryFact, 'subject' | 'statement' | 'files'>): Promise<RepositoryFact> {
  return h.repos.facts.upsert({
    id: newId(),
    projectId: h.project.id,
    kind: 'module',
    source: 'agent',
    confidence: 'high',
    fingerprint: await fingerprintFiles(h.repoDir, over.files),
    stale: false,
    createdAt: nowIso(),
    verifiedAt: nowIso(),
    ...over,
  })
}

const serverTask = plannedTask('endpoint', {
  title: 'Implement the server endpoint',
  description: 'Add the request handler to the API server.',
  suggestedFiles: ['src/api/server.ts'],
  acceptanceCriteria: ['The handler exists'],
})

describe('scenario: Context Engine V2', () => {
  let h: Harness
  afterEach(async () => h?.dispose())

  it('a fact whose supporting file changed is marked stale by the refresh and leaves the next context pack', async () => {
    h = await createHarness({ files: FILES, script: scenarioScript({ plan: plan([serverTask]) }) })
    const seeded = await fact(h, { subject: 'src/api', statement: 'The API server registers handlers in server.ts (STALE-MARKER).', files: ['src/api/server.ts'] })

    const first = await h.startRun()
    expect((await h.waitForState(first.id, 'completed')).state).toBe('completed')
    const pack1 = h.repos.contextPacks.listByTask(h.task(first.id, 'endpoint').id)[0]
    expect(pack1?.entries.find((e) => e.sourceId === seeded.id)).toMatchObject({ included: true, sourceKind: 'repository_fact' })
    expect(sessionsOf(h, 'worker')[0]?.prompt).toContain('## Repository intelligence')
    expect(sessionsOf(h, 'worker')[0]?.prompt).toContain('STALE-MARKER')

    // A supporting file changes in the repository.
    await writeFile(join(h.repoDir, 'src/api/server.ts'), 'export const server = 2 // changed and longer\n')
    await git(h.repoDir, 'commit', '-am', 'change server')
    // No manual refresh: the second run's own start-of-run refresh must find the change.
    const second = await h.startRun()
    expect((await h.waitForState(second.id, 'completed')).state).toBe('completed')
    expect(h.eventsOfType(second.id, 'intelligence.refreshed')[0]?.payload.stale).toBeGreaterThanOrEqual(1)
    expect(h.repos.facts.listByProject(h.project.id, { includeStale: true }).find((f) => f.id === seeded.id)?.stale).toBe(true)
    const task2 = h.task(second.id, 'endpoint')
    const pack2 = h.repos.contextPacks.listByTask(task2.id)[0]
    expect(pack2?.entries.find((e) => e.sourceId === seeded.id)).toMatchObject({ included: false })
    expect(pack2?.entries.find((e) => e.sourceId === seeded.id)?.reason).toMatch(/Stale/)
    const prompt2 = sessionsOf(h, 'worker').at(-1)?.prompt ?? ''
    expect(prompt2).not.toContain('STALE-MARKER')
  })

  it('a pack records why each piece of project history was included or left out, and the prompt holds only the included ones', async () => {
    const worker: FakeScript = async (spec, ctx) => {
      const key = keyOf(spec)
      if (key === 'design') {
        const run = h.repos.runs.listByProject(h.project.id)[0]
        await ctx.nexusTools?.recordDecision({ title: 'Handler registry', decision: 'RELEVANT-DECISION: handlers register in server.ts', rationale: 'one place' })
        // A decision of an unrelated task (no dependency, not an architect).
        h.repos.decisions.insert({
          id: newId(),
          runId: run?.id ?? '',
          taskId: h.task(run?.id ?? '', 'other').id,
          agentId: null,
          title: 'Garden layout',
          decision: 'UNRELATED-DECISION: plant tomatoes',
          rationale: 'sun',
          createdAt: nowIso(),
        })
      }
      await fileWorker(spec, ctx)
    }
    h = await createHarness({
      files: FILES,
      script: scenarioScript({
        plan: plan([
          plannedTask('design'),
          plannedTask('other', { suggestedFiles: ['docs/guide.md'] }),
          { ...serverTask, dependencies: ['design'] },
        ]),
        worker,
      }),
    })
    const relevantFact = await fact(h, { subject: 'src/api', statement: 'RELEVANT-FACT: handlers live in src/api/server.ts.', files: ['src/api/server.ts'] })
    const unrelatedFact = await fact(h, { subject: 'docs', statement: 'UNRELATED-FACT: the guide explains onboarding.', files: ['docs/guide.md'] })
    const memory = (title: string, content: string, filePaths: string[]) =>
      h.repos.memory.insert({
        id: newId(),
        scope: 'project',
        projectId: h.project.id,
        runId: null,
        taskId: null,
        agentId: null,
        kind: 'note',
        title,
        content,
        tags: [],
        filePaths,
        source: 'user',
        evidence: null,
        status: 'approved',
        createdAt: nowIso(),
      })
    const relevantMemory = memory('Server handler convention', 'RELEVANT-MEMORY: every server handler validates input first.', ['src/api/server.ts'])
    const unrelatedMemory = memory('Compost schedule', 'UNRELATED-MEMORY: water the compost bin weekly.', [])

    const run = await h.startRun({ overrides: { maxParallelAgents: 1 } })
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')

    const task = h.task(run.id, 'endpoint')
    const pack = h.repos.contextPacks.listByTask(task.id)[0]
    expect(pack).toBeDefined()
    const entry = (sourceId: string) => pack?.entries.find((e) => e.sourceId === sourceId)

    expect(entry(relevantFact.id)).toMatchObject({ included: true, sourceKind: 'repository_fact', section: 'Repository intelligence' })
    expect(entry(relevantFact.id)?.reason).toMatch(/suggested file/)
    expect(entry(unrelatedFact.id)).toMatchObject({ included: false })
    expect(entry(unrelatedFact.id)?.reason).toMatch(/Not relevant/)
    expect(entry(relevantMemory.id)).toMatchObject({ included: true, sourceKind: 'memory' })
    expect(entry(unrelatedMemory.id)).toMatchObject({ included: false, sourceKind: 'memory' })
    const decisions = pack?.entries.filter((e) => e.sourceKind === 'decision') ?? []
    expect(decisions.find((d) => d.title === 'Handler registry')).toMatchObject({ included: true })
    expect(decisions.find((d) => d.title === 'Garden layout')).toMatchObject({ included: false })
    expect(decisions.find((d) => d.title === 'Garden layout')?.reason).toMatch(/does not depend on/)
    const dependency = pack?.entries.find((e) => e.sourceKind === 'dependency_output')
    expect(dependency).toMatchObject({ included: true })
    expect(pack?.entries.some((e) => e.sourceKind === 'task' && e.included)).toBe(true)
    expect(pack?.entries.some((e) => e.sourceKind === 'criteria' && e.included)).toBe(true)
    expect(pack?.entries.some((e) => e.sourceKind === 'worktree' && e.included)).toBe(true)
    // Excluded entries are bounded and every entry has a reason.
    expect(pack?.entries.filter((e) => !e.included).length).toBeLessThanOrEqual(30)
    for (const e of pack?.entries ?? []) expect(e.reason.length, e.title).toBeGreaterThan(0)

    // The prompt holds exactly the included history.
    const prompt = sessionsOf(h, 'worker').find((s) => s.prompt.includes('Task endpoint'))?.prompt ?? ''
    for (const marker of ['RELEVANT-FACT', 'RELEVANT-MEMORY', 'RELEVANT-DECISION']) expect(prompt).toContain(marker)
    for (const marker of ['UNRELATED-FACT', 'UNRELATED-MEMORY', 'UNRELATED-DECISION']) expect(prompt).not.toContain(marker)
    expect(pack?.totalChars).toBe(prompt.length)

    // The pack belongs to the agent that received it and was announced.
    const agent = h.repos.agents.listByTask(task.id).find((a) => a.purpose === 'implement')
    expect(pack?.agentId).toBe(agent?.id)
    const announced = h.eventsOfType(run.id, 'context.composed').find((e) => e.payload.packId === pack?.id)
    expect(announced?.payload.chars).toBe(pack?.totalChars)
    expect(announced?.payload.excluded).toBe((pack?.entries ?? []).filter((e) => !e.included).length)

    // Returned by the IPC handler, by task and by agent.
    expect((await ipc(h, 'context.packs', { taskId: task.id })).map((p) => p.id)).toContain(pack?.id)
    expect((await ipc(h, 'context.packs', { agentId: agent?.id ?? '' }))[0]?.id).toBe(pack?.id)
  })

  it('repair and resume prompts are recorded as packs too, one included entry per block', async () => {
    let reviews = 0
    h = await createHarness({
      script: scenarioScript({
        plan: plan([plannedTask('feature')]),
        reviewer: async (_s, ctx) =>
          ctx.completeTurn({ text: 'r', structuredOutput: ++reviews === 1 ? { summary: 'bad', findings: [{ title: 'Unvalidated input', description: 'd', evidence: 'e', severity: 'high', category: 'correctness', file: null, lineStart: null, lineEnd: null, confidence: 'high', suggestedCorrection: null }] } : { summary: 'ok', findings: [] } }),
      }),
    })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, ['completed', 'failed', 'paused'])).state).toBe('completed')
    const repairTask = h.repos.tasks.listByRun(run.id).find((t) => t.parentTaskId !== null)
    const repairAgent = h.repos.agents.listByTask(repairTask?.id ?? '').find((a) => a.purpose === 'diagnose')
    const packs = h.repos.contextPacks.listByAgent(repairAgent?.id ?? '')
    expect(packs).toHaveLength(1)
    expect(packs[0]?.entries.every((e) => e.included)).toBe(true)
    expect(packs[0]?.entries.map((e) => e.section)).toEqual(expect.arrayContaining(['Repair request', 'Task', 'Failure', 'Review findings']))
    expect(packs[0]?.totalChars).toBe(sessionsOf(h, 'debugger')[0]?.prompt.length)
  })

  it('every session that works on a task has a persisted pack', async () => {
    h = await createHarness({ script: scenarioScript({ plan: plan([plannedTask('a'), plannedTask('b', { dependencies: ['a'] })]) }) })
    const run = await h.startRun()
    expect((await h.waitForState(run.id, 'completed')).state).toBe('completed')
    for (const agent of h.repos.agents.listByRun(run.id).filter((a) => a.purpose === 'implement' || a.purpose === 'diagnose')) {
      expect(h.repos.contextPacks.listByAgent(agent.id).length, agent.label).toBeGreaterThanOrEqual(1)
    }
    // The dependant's pack hands over the dependency's result and says why.
    const b = h.repos.contextPacks.listByTask(h.task(run.id, 'b').id)[0]
    expect(b?.entries.find((e) => e.sourceKind === 'dependency_output')).toMatchObject({ included: true })
  })
})
