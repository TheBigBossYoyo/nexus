import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run, Task } from '@shared/domain'
import type { RunEvent } from '@shared/events'
import type { ProgressSnapshot } from '@shared/progress'
import type { RawUserIntent } from '@shared/director-line'
import type { ProtectedStorage } from '../modules/intelligence/connection'

/**
 * 0.9: what the Director Line is given of the runtime. Three things, and no more: facts to read (the computed
 * progress of the missions that are going on, the last overnight report, the last checks), two controls of the
 * user's own missions (pause after the current task, continue), and the ordinary way a mission is created.
 *
 * What is not here is the point: no capability broker, no settings, no boundary inbox, no power, no shell. A
 * message from the paired phone cannot grant anything, because the line holds nothing that grants.
 *
 * 0.9.1: the owner asked for more control from away. The line can now do what the owner does at the machine with
 * their own work, through the window's own IPC entries: answer a blocked task (resolve its blocker with their words
 * as the note), add a task to a mission in progress, and stop a mission once they confirm. None of these grants a
 * permission: what the agents may do is still decided by the policy, the boundary inbox and the privilege service.
 */

export interface DirectorLineHostDeps {
  openRuns: () => Run[]
  projectName: (projectId: string) => string | null
  projects: () => { id: string; name: string }[]
  progressOf: (runId: string) => ProgressSnapshot | null
  eventsOf: (runId: string, afterSeq: number) => RunEvent[]
  pendingBoundaryRequests: () => number
  isOnline: () => boolean
  latestOvernightReport: () => string | null
  /** 0.9.1: what ran with administrator rights in the last day, said plainly. */
  privilegedActivity?: () => string
  pauseRun: (runId: string, detail: string) => Promise<unknown>
  resumeRun: (runId: string) => Promise<unknown>
  /** The same entry as the window's "new mission": admission, the Task Compiler and the capability broker follow from it. */
  createMission: (input: { projectId: string; prompt: string }) => Promise<{ id: string }>
  /** 0.9.1: the tasks of a run, to find what is blocked. */
  tasksOf?: (runId: string) => Pick<Task, 'id' | 'title' | 'state' | 'blockedReason'>[]
  /**
   * 0.9.1: the window's own entries, through the same IPC handlers (so the Task Compiler admits the operator's words as
   * it admits what is typed at the machine): resolve a blocker with a note, add a task to a run, cancel a run.
   */
  resolveBlocker?: (taskId: string, note: string) => Promise<unknown>
  addTask?: (input: { runId: string; title: string; description: string }) => Promise<{ id: string }>
  cancelRun?: (runId: string) => Promise<unknown>
  /** Told of every event of the runtime, to pause a mission when its current task is done. */
  subscribe: (listener: (event: RunEvent) => void) => void
  logger: (line: string) => void
}

export function createDirectorLineHost(deps: DirectorLineHostDeps) {
  /** Missions to pause when their current task is done, and intents to start when a mission ends. */
  const pauseAfterTask = new Set<string>()
  const afterCurrent: { projectId: string; prompt: string; waitsFor: Set<string> }[] = []

  deps.subscribe((event) => {
    if (event.type === 'task.completed' && pauseAfterTask.delete(event.runId)) {
      void deps.pauseRun(event.runId, 'Paused from the Director Line after the task that was running').catch((e: unknown) => deps.logger(`director line: pause failed: ${e instanceof Error ? e.message : String(e)}`))
    }
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      pauseAfterTask.delete(event.runId)
      for (const queued of [...afterCurrent]) {
        queued.waitsFor.delete(event.runId)
        if (queued.waitsFor.size > 0) continue
        afterCurrent.splice(afterCurrent.indexOf(queued), 1)
        void deps.createMission({ projectId: queued.projectId, prompt: queued.prompt }).catch((e: unknown) => deps.logger(`director line: a queued task could not be started: ${e instanceof Error ? e.message : String(e)}`))
      }
    }
  })

  const nameOf = (run: Run): string => `${deps.projectName(run.projectId) ?? 'project'}: ${run.prompt.replace(/\s+/g, ' ').slice(0, 60)}`

  /** The project a remote task is for: the one named, when exactly one name matches; else the one of the work going on. */
  const projectFor = (hint: string | null): { id: string; name: string } | null => {
    const all = deps.projects()
    if (hint !== null && hint.trim() !== '') {
      const wanted = hint.trim().toLowerCase()
      const exact = all.filter((p) => p.name.toLowerCase() === wanted)
      if (exact.length === 1) return exact[0] ?? null
      const partial = all.filter((p) => p.name.toLowerCase().includes(wanted))
      return partial.length === 1 ? (partial[0] ?? null) : null
    }
    const active = [...new Set(deps.openRuns().map((r) => r.projectId))]
    if (active.length === 1) return all.find((p) => p.id === active[0]) ?? null
    return all.length === 1 ? (all[0] ?? null) : null
  }

  // ---- 0.9.1: blocked work, and which mission a message means ----------------------------------------------------

  const ref = (prefix: 'R' | 'T', id: string): string => `${prefix}-${id.slice(0, 8)}`
  const flat = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)
  type Blocked = { run: Run; task: Pick<Task, 'id' | 'title' | 'state' | 'blockedReason'> }
  const blockedOf = (runs: Run[]): Blocked[] => runs.flatMap((run) => (deps.tasksOf?.(run.id) ?? []).filter((t) => t.state === 'blocked').map((task) => ({ run, task })))

  /** A reference given in the context (R-…, T-…), an id's start, or a name: the runs and blocked tasks it means. */
  const resolve = (target: string | null): { runs: Run[]; blocked: Blocked[] } => {
    const runs = deps.openRuns()
    const all = blockedOf(runs)
    if (target === null || target.trim() === '') return { runs, blocked: all }
    const t = target.trim().toLowerCase().replace(/^[rt][-\s]?(?=[0-9a-f]{6})/, '')
    const byTask = all.filter((b) => b.task.id.toLowerCase().startsWith(t))
    if (t.length >= 6 && byTask.length === 1) return { runs: [byTask[0]!.run], blocked: byTask }
    const byRun = runs.filter((r) => r.id.toLowerCase().startsWith(t))
    if (t.length >= 6 && byRun.length === 1) return { runs: byRun, blocked: all.filter((b) => b.run.id === byRun[0]!.id) }
    if (t.length < 3) return { runs: [], blocked: [] }
    const named = runs.filter((r) => (deps.projectName(r.projectId) ?? '').toLowerCase().includes(t) || r.prompt.toLowerCase().includes(t))
    const byTitle = all.filter((b) => b.task.title.toLowerCase().includes(t))
    if (named.length > 0) return { runs: named, blocked: all.filter((b) => named.some((r) => r.id === b.run.id)) }
    return { runs: [...new Map(byTitle.map((b) => [b.run.id, b.run])).values()], blocked: byTitle }
  }

  const which = (runs: Run[]): string => runs.slice(0, 5).map((r) => `${nameOf(r)} (${ref('R', r.id)})`).join('; ')

  /** The one open run a message means, or why it is not one. */
  const oneRun = (target: string | null): { ok: true; run: Run } | { ok: false; text: string } => {
    const { runs } = resolve(target)
    if (runs.length === 1) return { ok: true, run: runs[0]! }
    if (runs.length === 0) return { ok: false, text: target ? `No open mission matches "${flat(target, 40)}".` : 'No mission is open.' }
    return { ok: false, text: `Which mission? ${which(runs)}. Say it with its name or its reference.` }
  }

  /** A mission that waits after an intervention or a pause by the user goes on; one that waits for a decision does not. */
  const continueRun = async (runId: string): Promise<boolean> => {
    const run = deps.openRuns().find((r) => r.id === runId)
    if (!run || run.state !== 'paused' || run.pauseReason !== 'user') return false
    pauseAfterTask.delete(runId)
    await deps.resumeRun(runId)
    return true
  }

  return {
    reads: {
      async getInterpretationContext() {
        const runs = deps.openRuns()
        if (runs.length === 0) return 'Open missions: none.'
        const blocked = blockedOf(runs)
        const lines = runs.slice(0, 8).flatMap((run) => [
          `- ${ref('R', run.id)} ${flat(nameOf(run), 90)} (state ${run.state}${run.pauseReason ? `, paused: ${run.pauseReason}` : ''})`,
          ...blocked.filter((b) => b.run.id === run.id).slice(0, 5).map((b) => `  - blocked task ${ref('T', b.task.id)} "${flat(b.task.title, 80)}": ${flat(b.task.blockedReason ?? 'no reason recorded', 240)}`),
        ])
        return ['Open missions (the R-… and T-… references are the targets you may name):', ...lines].join('\n')
      },
      async getStatus() {
        const runs = deps.openRuns()
        return {
          snapshots: runs.flatMap((run) => {
            const snapshot = deps.progressOf(run.id)
            return snapshot === null ? [] : [{ name: nameOf(run), snapshot }]
          }),
          facts: { paused: runs.some((r) => r.state === 'paused' && r.pauseReason === 'user'), online: deps.isOnline(), pendingBoundaryRequests: deps.pendingBoundaryRequests() },
        }
      },
      async getOvernightReport() {
        return deps.latestOvernightReport()
      },
      async getPrivilegedActivity() {
        return deps.privilegedActivity?.() ?? 'Nothing ran as administrator.'
      },
      async getLatestChecks() {
        let latest: RunEvent | null = null
        for (const run of deps.openRuns()) for (const event of deps.eventsOf(run.id, 0)) if (event.type === 'checks.completed' && (latest === null || event.createdAt > latest.createdAt)) latest = event
        if (latest === null) return null
        const p = latest.payload as { passed: boolean; failed: string[] }
        return { at: latest.createdAt, lines: p.passed ? ['The last checks passed.'] : [`The last checks failed: ${p.failed.length} of them.`, ...p.failed.slice(0, 5).map((f) => `- ${String(f).slice(0, 120)}`)] }
      },
    },
    actions: {
      async pauseAfterCurrentTask() {
        for (const run of deps.openRuns()) {
          if (run.state === 'paused' || run.state === 'awaiting_approval') continue
          pauseAfterTask.add(run.id)
        }
      },
      async resume() {
        pauseAfterTask.clear()
        for (const run of deps.openRuns()) {
          // Only what the user paused. A mission that waits for a provider, the network or a boundary decision is not "continued" from a phone.
          if (run.state === 'paused' && run.pauseReason === 'user') await deps.resumeRun(run.id)
        }
      },
      async submitIntent(intent: RawUserIntent): Promise<{ accepted: boolean; reference?: string; reason?: string }> {
        const project = projectFor(intent.projectHint)
        if (project === null) return { accepted: false, reason: intent.projectHint ? `No single project is named "${intent.projectHint.slice(0, 40)}".` : 'Say which project the task is for.' }
        const prompt = intent.text.trim().slice(0, 8000)
        if (prompt === '') return { accepted: false, reason: 'The task has no text.' }
        const busy = deps.openRuns().filter((r) => r.projectId === project.id && r.state !== 'paused')
        if (intent.afterCurrent && busy.length > 0) {
          if (afterCurrent.length >= 10) return { accepted: false, reason: 'Ten tasks are already waiting to follow the current work.' }
          afterCurrent.push({ projectId: project.id, prompt, waitsFor: new Set(busy.map((r) => r.id)) })
          return { accepted: true, reference: `queued after the current work in ${project.name}` }
        }
        const run = await deps.createMission({ projectId: project.id, prompt })
        return { accepted: true, reference: `mission ${run.id.slice(0, 8)} in ${project.name}` }
      },

      async answerBlocked(text: string, target: string | null) {
        if (!deps.resolveBlocker) return { ok: false, text: 'Answering blocked work is not available here.' }
        const { blocked } = resolve(target)
        if (blocked.length === 0) {
          const pending = deps.pendingBoundaryRequests()
          return { ok: false, text: `No task is blocked${target ? ` in "${flat(target, 40)}"` : ''}.${pending > 0 ? ` ${pending} request(s) wait for your decision at the machine.` : ''}` }
        }
        const note = `${text.trim()}\n(The owner's words, sent from the Director Line.)`
        const done: Blocked[] = []
        const failed: string[] = []
        for (const b of blocked.slice(0, 10)) {
          try {
            await deps.resolveBlocker(b.task.id, note)
            done.push(b)
          } catch (e) {
            failed.push(`"${flat(b.task.title, 50)}" (${flat(e instanceof Error ? e.message : 'it failed', 80)})`)
          }
        }
        const continued: string[] = []
        for (const run of new Map(done.map((b) => [b.run.id, b.run])).values()) if (await continueRun(run.id)) continued.push(nameOf(run))
        const parts = [
          done.length > 0 ? `Sent your words to ${done.length} blocked task(s): ${done.map((b) => `"${flat(b.task.title, 60)}"`).join(', ')}. They start again with them.` : 'Nothing was sent.',
          continued.length > 0 ? `Continued: ${continued.map((n) => flat(n, 60)).join('; ')}.` : '',
          failed.length > 0 ? `Not done for ${failed.join(', ')}.` : '',
          blocked.length > 10 ? `${blocked.length - 10} more blocked task(s) were left as they are.` : '',
        ]
        return { ok: done.length > 0, text: parts.filter(Boolean).join(' ') }
      },

      async addTaskToRun(text: string, target: string | null) {
        if (!deps.addTask) return { ok: false, text: 'Adding a task to a mission is not available here.' }
        const chosen = oneRun(target)
        if (!chosen.ok) return chosen
        const run = chosen.run
        const stillBlocked = blockedOf([run])
        const description = [
          text.trim(),
          '',
          '(The owner asked for this task from the Director Line, while this mission was in progress.)',
          ...(stillBlocked.length > 0 ? ['', 'Blocked tasks of this mission when it was asked:', ...stillBlocked.slice(0, 5).map((b) => `- "${flat(b.task.title, 80)}": ${flat(b.task.blockedReason ?? 'no reason recorded', 300)}`)] : []),
        ].join('\n')
        const title = flat(text.split('\n')[0] ?? text, 120) || 'Task from the Director Line'
        const task = await deps.addTask({ runId: run.id, title, description })
        const continued = await continueRun(run.id)
        const after = stillBlocked.length > 0 ? ` ${stillBlocked.length} task(s) of it are still blocked: answer them with "answer: …" for them to start again.` : ''
        return { ok: true, text: `Added to ${flat(nameOf(run), 70)}: "${flat(title, 80)}" (${ref('T', task.id)}).${continued ? ' The mission continues.' : ''}${after}` }
      },

      async stopTarget(target: string | null) {
        const chosen = oneRun(target)
        return chosen.ok ? { ok: true as const, runId: chosen.run.id, name: nameOf(chosen.run) } : chosen
      },

      async stopRun(runId: string) {
        if (!deps.cancelRun) return { ok: false, text: 'Stopping a mission is not available here.' }
        const run = deps.openRuns().find((r) => r.id === runId)
        if (!run) return { ok: false, text: 'That mission is no longer open: nothing was stopped.' }
        pauseAfterTask.delete(runId)
        await deps.cancelRun(runId)
        return { ok: true, text: `Stopped: ${flat(nameOf(run), 80)}. Its branches are kept.` }
      },
    },
  }
}

/**
 * The secrets of the Director Line (the bot's token, a relay key), kept in one file that is encrypted for the
 * Windows user by the operating system (the same protected storage as the ChatGPT connection). Nothing is kept
 * when that storage is not available: a token is never written in the clear.
 */
export function protectedSecretStore(dir: string, storage: ProtectedStorage | undefined) {
  const file = join(dir, 'secrets.bin')
  const load = (): Record<string, string> => {
    if (storage === undefined || !storage.available() || !existsSync(file)) return {}
    try {
      return JSON.parse(storage.decrypt(readFileSync(file))) as Record<string, string>
    } catch {
      return {}
    }
  }
  const save = (all: Record<string, string>): void => {
    if (storage === undefined || !storage.available()) throw new Error('The protected storage of Windows is not available, so the secret was not kept.')
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, storage.encrypt(JSON.stringify(all)))
  }
  return {
    async get(name: string): Promise<string | null> {
      return load()[name] ?? null
    },
    async set(name: string, value: string): Promise<void> {
      save({ ...load(), [name]: value })
    },
    async delete(name: string): Promise<void> {
      const all = load()
      if (!(name in all)) return
      delete all[name]
      save(all)
    },
  }
}
