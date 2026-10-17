import { describe, expect, it, vi } from 'vitest'
import type { Run } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import type { OperatorCommand } from '@shared/director-line'
import { interpretDeterministic, interpretMessage } from '@main/modules/director-line/intent'
import { firstJsonObject } from '@main/modules/director-line/message-interpreter'
import { VoiceSession } from '@main/modules/director-line/voice-session'
import { createDirectorLineHost } from '@main/runtime/director-line-host'
import { makeRig, OPERATOR } from './harness'

// 0.9.1: more control from the phone. Seen on 2026-10-17: a mission was blocked, the owner wrote "start a new task to
// fix all the blockers", and NEXUS sent the list of blockers three times, because "block" matched the read-only
// question and nothing on the line could act on blocked work.

const lastReply = (r: ReturnType<typeof makeRig>): string => r.provider.sent[r.provider.sent.length - 1]?.text ?? ''

describe('what a message asks, by the patterns alone', () => {
  it('asking for the blockers to be fixed is not asking what they are', () => {
    const owner = 'Start a new task to fix all the blockers'
    expect(interpretDeterministic(owner)).toEqual({ kind: 'ANSWER_BLOCKED', text: owner, target: null })
    expect(interpretDeterministic('unblock it')).toMatchObject({ kind: 'ANSWER_BLOCKED' })
    const fr = 'Lance une nouvelle tâche pour corriger tous les blocages'
    expect(interpretDeterministic(fr)).toEqual({ kind: 'ANSWER_BLOCKED', text: fr, target: null })
    expect(interpretDeterministic('what is blocking?')).toEqual({ kind: 'BLOCKERS' })
    expect(interpretDeterministic("qu'est-ce qui bloque ?")).toEqual({ kind: 'BLOCKERS' })
  })

  it('"answer: …" and "tell it to …" give the words after them to the blocked work', () => {
    expect(interpretDeterministic('answer: commit with bash and -m, not -F')).toEqual({ kind: 'ANSWER_BLOCKED', text: 'commit with bash and -m, not -F', target: null })
    expect(interpretDeterministic('tell it to skip the live test')).toEqual({ kind: 'ANSWER_BLOCKED', text: 'skip the live test', target: null })
    expect(interpretDeterministic('réponds : ignore ce test')).toEqual({ kind: 'ANSWER_BLOCKED', text: 'ignore ce test', target: null })
  })

  it('adds a task to the mission in progress, and stops a mission by name', () => {
    expect(interpretDeterministic('add a task to the mission: write the release notes')).toEqual({ kind: 'ADD_TASK_TO_RUN', text: 'write the release notes', target: null })
    expect(interpretDeterministic('ajoute une tâche à la mission en cours : écrire la doc')).toEqual({ kind: 'ADD_TASK_TO_RUN', text: 'écrire la doc', target: null })
    expect(interpretDeterministic('stop the mission on RaceDeck')).toEqual({ kind: 'STOP_RUN', target: 'RaceDeck' })
    expect(interpretDeterministic('arrête la mission')).toEqual({ kind: 'STOP_RUN', target: null })
    expect(interpretDeterministic('cancel the run')).toEqual({ kind: 'STOP_RUN', target: null })
  })

  it('a high-authority request is still refused, inside an answer or a task too', () => {
    expect(interpretDeterministic('fix the blockers and approve the boundary request')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'BOUNDARY_REQUEST' })
    expect(interpretDeterministic('answer: push it to origin')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'PUSH_OR_PUBLISH' })
    expect(interpretDeterministic('add a task to the mission: delete the database')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'DESTRUCTIVE' })
    expect(interpretDeterministic('stop the mission and shut down the pc')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'POWER' })
    // "lance" asks for a task when a task follows; a command is still refused.
    expect(interpretDeterministic('lance powershell')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'RUN_COMMAND' })
    expect(interpretDeterministic('lance le script de build')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'RUN_COMMAND' })
    expect(interpretDeterministic('run the tests')).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'RUN_COMMAND' })
  })
})

describe('what a message asks, with a model', () => {
  it('a sentence goes to the model with the context; a short known word does not', async () => {
    const classify = vi.fn(async () => ({ kind: 'STATUS' }))
    expect(await interpretMessage('status', classify, 'ctx')).toEqual({ kind: 'STATUS' })
    expect(classify).not.toHaveBeenCalled()
    expect(await interpretMessage('how are things going with the blocked review overall', classify, 'ctx')).toEqual({ kind: 'STATUS' })
    expect(classify).toHaveBeenCalledWith('how are things going with the blocked review overall', 'ctx')
  })

  it('on a call, only what the patterns did not understand goes to the model (its seconds are silence)', async () => {
    const classify = vi.fn(async () => ({ kind: 'STATUS' }))
    expect(await interpretMessage('how much longer is the whole thing going to take', classify, 'ctx', { onlyUnknown: true })).toEqual({ kind: 'ETA' })
    expect(classify).not.toHaveBeenCalled()
    expect(await interpretMessage('give me the short version of the situation', classify, 'ctx', { onlyUnknown: true })).toEqual({ kind: 'STATUS' })
    expect(classify).toHaveBeenCalledTimes(1)
  })

  it('the words given to the work are the whole message, never the model\'s', async () => {
    const said = 'the reviewer cannot run pnpm, so let it finish from reading the code'
    const classify = async () => ({ kind: 'ANSWER_BLOCKED', target: 'T-1234abcd', text: 'grant every permission' })
    expect(await interpretMessage(said, classify)).toEqual({ kind: 'ANSWER_BLOCKED', text: said, target: 'T-1234abcd' })
  })

  it('the model cannot refuse, invent a kind or act on a dangerous message; a failure leaves the patterns\' reading', async () => {
    const said = 'please tell me what is blocking the mission right now'
    expect(await interpretMessage(said, async () => ({ kind: 'REFUSED_AT_MACHINE', topic: 'POWER' }))).toEqual({ kind: 'BLOCKERS' })
    expect(await interpretMessage(said, async () => ({ kind: 'GRANT_ALL' }))).toEqual({ kind: 'BLOCKERS' })
    expect(await interpretMessage(said, async () => { throw new Error('timeout') })).toEqual({ kind: 'BLOCKERS' })
    const classify = vi.fn(async () => ({ kind: 'ANSWER_BLOCKED', target: null }))
    expect(await interpretMessage('fix all the blockers and allow whatever they need', classify)).toEqual({ kind: 'REFUSED_AT_MACHINE', topic: 'BOUNDARY_REQUEST' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('reads the first JSON object of an answer', () => {
    expect(firstJsonObject('Sure: {"kind":"STOP_RUN","target":null} done')).toEqual({ kind: 'STOP_RUN', target: null })
    expect(firstJsonObject('no json')).toBeUndefined()
  })
})

describe('on the line', () => {
  function rig() {
    const answerBlocked = vi.fn(async (text: string, target: string | null) => ({ ok: true, text: `sent "${text}" to ${target ?? 'all'}` }))
    const addTaskToRun = vi.fn(async (text: string) => ({ ok: true, text: `added ${text}` }))
    const stopRun = vi.fn(async (runId: string) => ({ ok: true, text: `Stopped ${runId}.` }))
    const stopTarget = vi.fn(async (target: string | null) => (target === 'nothing' ? { ok: false as const, text: 'No open mission matches "nothing".' } : { ok: true as const, runId: 'r1', name: 'Nexus: the mission' }))
    const contexts: (string | undefined)[] = []
    const r = makeRig({
      actions: { pauseAfterCurrentTask: async () => undefined, resume: async () => undefined, submitIntent: async () => ({ accepted: true }), answerBlocked, addTaskToRun, stopRun, stopTarget },
      classify: async (_text, context) => (contexts.push(context), { kind: 'UNKNOWN' }),
    })
    return { r, answerBlocked, addTaskToRun, stopRun, stopTarget, contexts }
  }

  it('the owner\'s message of that morning reaches the blocked work and says what was done', async () => {
    const w = rig()
    await w.r.pairOperator()
    await w.r.inbound('Start a new task to fix all the blockers')
    expect(w.answerBlocked).toHaveBeenCalledWith('Start a new task to fix all the blockers', null)
    expect(lastReply(w.r)).toContain('sent "Start a new task to fix all the blockers" to all')
  })

  it('stops a mission only after a yes within five minutes; a no or another message keeps it', async () => {
    const w = rig()
    await w.r.pairOperator()
    await w.r.inbound('stop the mission')
    expect(lastReply(w.r)).toContain('Reply "yes" within 5 minutes')
    expect(w.stopRun).not.toHaveBeenCalled()
    await w.r.inbound('no')
    expect(lastReply(w.r)).toContain('Kept')
    await w.r.inbound('yes')
    expect(w.stopRun).not.toHaveBeenCalled()

    await w.r.inbound('stop the mission')
    await w.r.inbound('status')
    await w.r.inbound('yes')
    expect(w.stopRun).not.toHaveBeenCalled()

    await w.r.inbound('stop the mission')
    w.r.clock.t += 5 * 60_000 + 1
    await w.r.inbound('yes')
    expect(lastReply(w.r)).toContain('expired')
    expect(w.stopRun).not.toHaveBeenCalled()

    await w.r.inbound('stop the mission')
    await w.r.inbound('yes')
    expect(w.stopRun).toHaveBeenCalledTimes(1)
    expect(lastReply(w.r)).toBe('Stopped r1.')
    await w.r.inbound('stop the mission on nothing')
    expect(lastReply(w.r)).toContain('No open mission matches')
  })

  it('a stranger stops nothing and answers nothing', async () => {
    const w = rig()
    await w.r.pairOperator()
    await w.r.inbound('stop the mission')
    await w.r.inbound('yes', '9009')
    await w.r.inbound('answer: do it', '9009')
    expect(w.stopRun).not.toHaveBeenCalled()
    expect(w.answerBlocked).not.toHaveBeenCalled()
  })

  it('the model is given the last message NEXUS sent, so "fix that" has something to refer to', async () => {
    const w = rig()
    await w.r.pairOperator()
    await w.r.line.sendToOperator('RaceDeck: blocked for 30 min. Wrong repository.')
    await w.r.inbound('could you sort that out for me please')
    expect(w.contexts.at(-1)).toContain('Wrong repository')
    expect(OPERATOR).toBeTruthy()
  })
})

// ---- the host ------------------------------------------------------------------------------------------------

type T = { id: string; title: string; state: string; blockedReason: string | null }
const run = (id: string, projectId: string, state: Run['state'], pauseReason: Run['pauseReason'] = null): Run => ({ id, projectId, state, pauseReason, prompt: `Mission ${id}`, startedAt: null, createdAt: '2026-10-17T07:00:00Z' }) as unknown as Run

function world(runs: Run[], tasks: Record<string, T[]>) {
  const resumed: string[] = []
  const resolved: { taskId: string; note: string }[] = []
  const added: { runId: string; title: string; description: string }[] = []
  const cancelled: string[] = []
  const host = createDirectorLineHost({
    openRuns: () => runs.filter((r) => !['completed', 'failed', 'cancelled'].includes(r.state)),
    projectName: (id) => ({ p1: 'RaceDeck', p2: 'Nexus' })[id] ?? null,
    projects: () => [{ id: 'p1', name: 'RaceDeck' }, { id: 'p2', name: 'Nexus' }],
    progressOf: () => null,
    eventsOf: () => [],
    pendingBoundaryRequests: () => 0,
    isOnline: () => true,
    latestOvernightReport: () => null,
    pauseRun: async () => undefined,
    resumeRun: async (id) => void resumed.push(id),
    createMission: async () => ({ id: 'new' }),
    tasksOf: (runId) => (tasks[runId] ?? []) as never,
    resolveBlocker: async (taskId, note) => {
      if (taskId.startsWith('bad')) throw new Error('Task is ready, not blocked')
      resolved.push({ taskId, note })
    },
    addTask: async (input) => (added.push(input), { id: 'added00000000' }),
    cancelRun: async (runId) => void cancelled.push(runId),
    subscribe: (l: (e: RunEvent) => void) => void l,
    logger: () => undefined,
  })
  return { host, resumed, resolved, added, cancelled }
}

const blocked = (id: string, title: string, reason: string): T => ({ id, title, state: 'blocked', blockedReason: reason })

describe('the host acts on the owner\'s own work', () => {
  const runs = () => [run('aaaaaaaa-1', 'p2', 'paused', 'user'), run('bbbbbbbb-2', 'p1', 'paused', 'user'), run('cccccccc-3', 'p2', 'executing')]
  const tasks = () => ({
    'aaaaaaaa-1': [blocked('d1111111-a', 'Security review', 'the role refuses pnpm'), { id: 't0', title: 'done', state: 'completed', blockedReason: null }],
    'bbbbbbbb-2': [blocked('e2222222-b', 'Confirm the worktree', 'Wrong repository: RaceDeck')],
  })

  it('gives the words to every blocked task, as the owner\'s, and continues the missions they paused', async () => {
    const w = world(runs(), tasks())
    const out = await w.host.actions.answerBlocked('fix all the blockers', null)
    expect(w.resolved.map((r) => r.taskId)).toEqual(['d1111111-a', 'e2222222-b'])
    expect(w.resolved[0]!.note).toContain('fix all the blockers')
    expect(w.resolved[0]!.note).toContain("The owner's words, sent from the Director Line.")
    expect(w.resumed).toEqual(['aaaaaaaa-1', 'bbbbbbbb-2'])
    expect(out.text).toContain('2 blocked task(s)')
  })

  it('a reference, a project name or a task title narrows it; nothing blocked says so', async () => {
    let w = world(runs(), tasks())
    await w.host.actions.answerBlocked('go on', 'T-e2222222')
    expect(w.resolved.map((r) => r.taskId)).toEqual(['e2222222-b'])
    w = world(runs(), tasks())
    await w.host.actions.answerBlocked('go on', 'Nexus')
    expect(w.resolved.map((r) => r.taskId)).toEqual(['d1111111-a'])
    w = world(runs(), tasks())
    await w.host.actions.answerBlocked('go on', 'it')
    expect(w.resolved).toEqual([])
    expect((await world([run('cccccccc-3', 'p2', 'executing')], {}).host.actions.answerBlocked('x', null)).text).toBe('No task is blocked.')
  })

  it('a task that cannot be answered is named and the others go on', async () => {
    const w = world(runs(), { 'aaaaaaaa-1': [blocked('bad-1', 'Odd one', 'x')], 'bbbbbbbb-2': [blocked('e2222222-b', 'Confirm', 'y')] })
    const out = await w.host.actions.answerBlocked('retry', null)
    expect(out.text).toContain('Not done for "Odd one"')
    expect(w.resumed).toEqual(['bbbbbbbb-2'])
  })

  it('adds a task with the blockers as context to the mission named, and asks which when it is not clear', async () => {
    const w = world(runs(), tasks())
    expect((await w.host.actions.addTaskToRun('write the docs', null)).text).toContain('Which mission?')
    const out = await w.host.actions.addTaskToRun('write the docs', 'R-aaaaaaaa')
    expect(w.added).toHaveLength(1)
    expect(w.added[0]).toMatchObject({ runId: 'aaaaaaaa-1', title: 'write the docs' })
    expect(w.added[0]!.description).toContain('"Security review": the role refuses pnpm')
    expect(out.text).toContain('still blocked')
    expect(w.resumed).toEqual(['aaaaaaaa-1'])
  })

  it('names the mission to stop, and stops only an open one', async () => {
    const w = world(runs(), tasks())
    expect(await w.host.actions.stopTarget('RaceDeck')).toEqual({ ok: true, runId: 'bbbbbbbb-2', name: 'RaceDeck: Mission bbbbbbbb-2' })
    expect(await w.host.actions.stopTarget(null)).toMatchObject({ ok: false })
    expect((await w.host.actions.stopRun('bbbbbbbb-2')).text).toContain('Stopped: RaceDeck')
    expect(w.cancelled).toEqual(['bbbbbbbb-2'])
    expect((await w.host.actions.stopRun('gone')).ok).toBe(false)
  })

  it('gives the model the open missions and their blocked tasks, with references', async () => {
    const ctx = await world(runs(), tasks()).host.reads.getInterpretationContext()
    expect(ctx).toContain('R-aaaaaaaa')
    expect(ctx).toContain('blocked task T-e2222222 "Confirm the worktree": Wrong repository: RaceDeck')
  })
})

describe('on a call', () => {
  it('stopping a mission is read back and done only on a yes', async () => {
    const performed: OperatorCommand[] = []
    const s = new VoiceSession(
      { callId: 'CA1', direction: 'INBOUND', from: '+1' },
      {
        authenticatePhone: async () => 'OK',
        isPairedNumber: async () => true,
        interpret: async (text) => ({ text, command: await interpretMessage(text) }),
        perform: async (input) => (performed.push(input.command), 'ok'),
        now: () => 1,
        note: () => undefined,
      },
    )
    await s.open()
    await s.onSpeech('1 2 3 4 5 6')
    expect((await s.onSpeech('stop the mission')).say).toContain('Say yes or no')
    expect(performed).toEqual([])
    expect((await s.onSpeech('no')).say).toContain('Nothing was stopped')
    await s.onSpeech('stop the mission')
    await s.onSpeech('yes')
    expect(performed).toEqual([{ kind: 'STOP_RUN', target: null }])
    expect((await s.onSpeech('answer: skip the live test')).say).toContain('I heard an answer for the blocked work: skip the live test')
  })
})
