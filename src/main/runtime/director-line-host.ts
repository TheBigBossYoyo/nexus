import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Run } from '@shared/domain'
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

  return {
    reads: {
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
