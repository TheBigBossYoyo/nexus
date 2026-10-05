import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ControlPlaneOverview } from '@shared/control-plane'
import type { RuntimeStatus } from '@shared/runtime-protocol'
import type { WorkersOverview } from '@shared/workers'
import { buildRuntime, call, connect, processAlive, removeDir, startRuntime, tempDataDir, until, type RuntimeProcess } from '../helpers/runtime-process'
import type { RuntimeClient } from '@main/modules/runtime/client'

/**
 * A soak of the real runtime process with the scripted agent runtime in real worker processes. For the given
 * number of minutes it keeps the runtime busy the way a long day would: missions are started, queue items are
 * held and released, dispatch is paused and resumed, one-time schedules come due, workers are ended from
 * outside, clients come and go, and now and then the runtime itself is killed and started again. Every half
 * minute it records what the runtime process uses. At the end it checks that nothing grew without bound and
 * that nothing was left behind.
 *
 *   NEXUS_SOAK_MINUTES=90 pnpm vitest run -c vitest.stress.config.ts tests/stress/soak-runtime.test.ts
 *
 * Skipped unless NEXUS_SOAK_MINUTES is set. The samples go to test-results/soak/soak-<start>.jsonl.
 */
const MINUTES = Number(process.env['NEXUS_SOAK_MINUTES'] ?? 0)
const RESTART_EVERY_MIN = Number(process.env['NEXUS_SOAK_RESTART_MINUTES'] ?? 12)
const OUT_DIR = join(process.cwd(), 'test-results', 'soak')

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function createRepo(): string {
  const root = tempDataDir('soak-repo')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Soak')
  git(root, 'config', 'user.email', 'soak@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'README.md'), '# Soak project\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'soak', version: '1.0.0' }) + '\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Initial commit')
  return root
}

interface Sample {
  at: string
  minute: number
  boot: number
  rssMb: number
  heapUsedMb: number
  timers: number
  handles: number
  dbMb: number
  walMb: number
  liveWorkers: number
  activeLeases: number
  queueOpen: number
  queueFinished: number
  runsStarted: number
  runsFinished: number
  worktreeDirs: number
  workerProcesses: number
}

describe.skipIf(MINUTES <= 0)('runtime soak', () => {
  it(
    `runs ${MINUTES} minutes of mixed work without leaks or leftovers`,
    async () => {
      await buildRuntime()
      mkdirSync(OUT_DIR, { recursive: true })
      const outFile = join(OUT_DIR, `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
      const dataDir = tempDataDir('soak')
      const repo = createRepo()
      const env = { NEXUS_FAKE_WORKERS: '1' }
      let seed = 20261005
      const rnd = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed / 4294967296
      }
      const samples: Sample[] = []
      const problems: string[] = []
      const runs: string[] = []
      const finished = new Set<string>()
      const counters = { runtimeRestarts: 0, workersKilled: 0, clientReconnects: 0, pauses: 0, schedules: 0, holds: 0, cancels: 0 }
      let boot = 1
      let runtime: RuntimeProcess = await startRuntime(dataDir, env)
      let client: RuntimeClient = await connect(dataDir)
      const waitReady = (): Promise<RuntimeStatus> =>
        until(
          () => call<RuntimeStatus>(client, 'runtime.status'),
          (s) => s.phase === 'READY',
          60_000,
          'the runtime to be ready',
        )
      await waitReady()
      await call(client, 'control.setLimits', { limits: { maxAgents: 4, maxActiveItems: 3, resumeOnBoot: 'resume', agingMinutes: 5 } })
      const project = await call<{ id: string }>(client, 'projects.open', { path: repo })
      const startedAt = Date.now()
      const end = startedAt + MINUTES * 60_000
      let lastSample = 0
      let lastRestart = Date.now()
      const workerPidsSeen = new Set<number>()

      const sample = async (): Promise<void> => {
        const status = await call<RuntimeStatus>(client, 'runtime.status')
        const overview = await call<ControlPlaneOverview>(client, 'control.overview')
        const workers = await call<WorkersOverview>(client, 'runtime.workers')
        for (const w of workers.workers) if (w.pid !== null && w.bootId === status.bootId && w.state !== 'STOPPED' && w.state !== 'FAILED') workerPidsSeen.add(w.pid)
        for (const item of overview.finished) if (item.refId) finished.add(item.refId)
        const active = workers.leases.filter((l) => l.state === 'ACTIVE')
        // The invariants of the stress hold on the real thing too, at every sample.
        if (new Set(active.map((l) => l.agentId)).size !== active.length) problems.push('an agent session held two active leases')
        if (new Set(active.map((l) => l.workerId)).size !== active.length) problems.push('a worker held two active leases')
        if (overview.agents.active > overview.agents.max) problems.push(`${overview.agents.active} agents ran with a limit of ${overview.agents.max}`)
        if (workers.counts.live > workers.limits.maxWorkers + 1) problems.push(`${workers.counts.live} workers with a limit of ${workers.limits.maxWorkers}`)
        const worktreeDirs = ((): number => {
          try {
            return readdirSync(join(dataDir, 'worktrees')).length
          } catch {
            return 0
          }
        })()
        const s: Sample = {
          at: new Date().toISOString(),
          minute: Math.round(((Date.now() - startedAt) / 60_000) * 10) / 10,
          boot,
          rssMb: status.resources.rssMb,
          heapUsedMb: status.resources.heapUsedMb,
          timers: status.resources.timers,
          handles: status.resources.handles,
          dbMb: status.resources.dbMb,
          walMb: status.resources.walMb,
          liveWorkers: workers.counts.live,
          activeLeases: active.length,
          queueOpen: overview.active.length + overview.waiting.length + overview.scheduled.length,
          queueFinished: finished.size,
          runsStarted: runs.length,
          runsFinished: runs.filter((id) => finished.has(id)).length,
          worktreeDirs,
          workerProcesses: [...workerPidsSeen].filter(processAlive).length,
        }
        samples.push(s)
        appendFileSync(outFile, JSON.stringify(s) + '\n')
      }

      try {
        while (Date.now() < end && problems.length === 0) {
          const overview = await call<ControlPlaneOverview>(client, 'control.overview')
          const open = [...overview.active, ...overview.waiting]
          const roll = rnd()
          try {
            if (open.length < 5 && roll < 0.45) {
              const run = await call<{ id: string }>(client, 'runs.create', { projectId: project.id, mode: 'build', preset: 'balanced', prompt: `Build the demo modules (soak ${runs.length + 1})`, requirePlanApproval: false })
              runs.push(run.id)
            } else if (roll < 0.52 && open.length > 0) {
              const item = open[Math.floor(rnd() * open.length)]
              if (item) {
                counters.holds += 1
                await call(client, 'control.pause', { itemId: item.id })
                await new Promise((r) => setTimeout(r, 1500))
                await call(client, 'control.resume', { itemId: item.id })
              }
            } else if (roll < 0.57) {
              counters.pauses += 1
              await call(client, 'runtime.setDispatchPaused', { paused: true })
              await new Promise((r) => setTimeout(r, 2500))
              await call(client, 'runtime.setDispatchPaused', { paused: false })
            } else if (roll < 0.63) {
              const workers = await call<WorkersOverview>(client, 'runtime.workers')
              const busy = workers.workers.filter((w) => w.assignment && w.pid !== null && (w.state === 'RUNNING' || w.state === 'ASSIGNED'))
              const victim = busy[Math.floor(rnd() * busy.length)]
              if (victim?.pid) {
                counters.workersKilled += 1
                try {
                  execFileSync('taskkill', ['/PID', String(victim.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
                } catch {
                  // It ended by itself in the meantime.
                }
              }
            } else if (roll < 0.7) {
              counters.clientReconnects += 1
              client.close()
              await new Promise((r) => setTimeout(r, 1000))
              client = await connect(dataDir)
            } else if (roll < 0.76) {
              counters.schedules += 1
              const program = await call<{ id: string }>(client, 'program.create', { projectId: project.id, name: `Soak program ${counters.schedules}`, goal: 'Build the demo modules.', preset: 'autonomous', start: false })
              await call(client, 'control.createSchedule', { schedule: { name: `soak-${counters.schedules}`, rule: { kind: 'once', at: new Date(Date.now() + 5000).toISOString() }, action: { type: 'program', programId: program.id }, priority: 'P3', enabled: true } })
            } else if (roll < 0.79 && open.length > 3) {
              const item = open[open.length - 1]
              if (item) {
                counters.cancels += 1
                await call(client, 'control.cancel', { itemId: item.id })
              }
            }
          } catch (e) {
            // A refusal of the runtime (an item that just finished, a run limit) is an answer. Anything else is a finding.
            const message = e instanceof Error ? e.message : String(e)
            if (!/invalid_state|not_found|runtime_unavailable|already/.test(message)) problems.push(`unexpected error: ${message}`)
          }

          if (Date.now() - lastRestart > RESTART_EVERY_MIN * 60_000) {
            // The runtime is killed, not stopped: no flush, no goodbye.
            counters.runtimeRestarts += 1
            lastRestart = Date.now()
            const old = runtime
            const oldWorkers = [...workerPidsSeen].filter(processAlive)
            client.close()
            await old.kill()
            await until(
              () => oldWorkers.filter(processAlive),
              (alive) => alive.length === 0,
              30_000,
              'the workers of the killed runtime to end',
            ).catch(() => problems.push(`workers outlived their runtime: ${oldWorkers.filter(processAlive).join(', ')}`))
            workerPidsSeen.clear()
            runtime = await startRuntime(dataDir, env)
            boot += 1
            client = await connect(dataDir)
            await waitReady()
          }
          if (Date.now() - lastSample > 30_000) {
            lastSample = Date.now()
            await sample()
          }
          await new Promise((r) => setTimeout(r, 2000 + Math.floor(rnd() * 3000)))
        }

        // Drain: nothing new; what is on the queue may finish.
        await call(client, 'runtime.setDispatchPaused', { paused: false }).catch(() => undefined)
        const drained = await until(
          () => call<ControlPlaneOverview>(client, 'control.overview'),
          (o) => o.active.length === 0 && o.waiting.filter((i) => i.state !== 'PAUSED' && i.state !== 'BLOCKED').length === 0,
          10 * 60_000,
          'the queue to drain',
        ).catch((e: unknown) => {
          problems.push(e instanceof Error ? e.message.slice(0, 600) : String(e))
          return null
        })
        await sample()
        const workers = await call<WorkersOverview>(client, 'runtime.workers')
        if (workers.leases.some((l) => l.state === 'ACTIVE')) problems.push('a lease was still active after the drain')
        if (drained && drained.health.level === 'BLOCKED') problems.push(`the runtime ended BLOCKED: ${JSON.stringify(drained.health.components.filter((c) => c.level !== 'HEALTHY'))}`)

        // Growth. Compared within one start of the runtime, between its early and its late samples.
        const lastBoot = samples.filter((s) => s.boot === boot)
        const first = lastBoot.slice(0, Math.max(1, Math.floor(lastBoot.length / 4)))
        const last = lastBoot.slice(-Math.max(1, Math.floor(lastBoot.length / 4)))
        const avg = (xs: Sample[], key: keyof Sample): number => xs.reduce((n, s) => n + (s[key] as number), 0) / xs.length
        const summary = {
          minutes: MINUTES,
          counters,
          runsStarted: runs.length,
          runsFinished: runs.filter((id) => finished.has(id)).length,
          samples: samples.length,
          lastBoot: { samples: lastBoot.length, rssMb: [avg(first, 'rssMb'), avg(last, 'rssMb')], heapUsedMb: [avg(first, 'heapUsedMb'), avg(last, 'heapUsedMb')], timers: [avg(first, 'timers'), avg(last, 'timers')], handles: [avg(first, 'handles'), avg(last, 'handles')] },
          max: { rssMb: Math.max(...samples.map((s) => s.rssMb)), timers: Math.max(...samples.map((s) => s.timers)), handles: Math.max(...samples.map((s) => s.handles)), liveWorkers: Math.max(...samples.map((s) => s.liveWorkers)), queueOpen: Math.max(...samples.map((s) => s.queueOpen)), walMb: Math.max(...samples.map((s) => s.walMb)) },
          end: samples.at(-1),
          problems,
        }
        writeFileSync(outFile.replace(/\.jsonl$/, '.summary.json'), JSON.stringify(summary, null, 2))
        console.log(`soak summary: ${JSON.stringify(summary)}`)

        if (lastBoot.length >= 8) {
          // Timers and handles belong to live work; with the queue drained they are back near where they began.
          expect(avg(last, 'timers'), 'pending timers grew').toBeLessThan(avg(first, 'timers') * 3 + 40)
          expect(avg(last, 'handles'), 'handles grew').toBeLessThan(avg(first, 'handles') * 3 + 40)
          expect(avg(last, 'heapUsedMb'), 'the heap grew').toBeLessThan(avg(first, 'heapUsedMb') * 2.5 + 60)
        }
        expect(summary.max.liveWorkers).toBeLessThanOrEqual(6)
        expect(summary.max.walMb, 'the write-ahead log grew without checkpoints').toBeLessThan(200)
        expect(runs.length).toBeGreaterThan(0)
        expect(problems).toEqual([])
      } finally {
        client.close()
        const pids = [...workerPidsSeen]
        await call(await connect(dataDir).catch(() => client), 'runtime.stop').catch(() => undefined)
        await runtime.exited(60_000).catch(() => runtime.kill())
        // No worker process is left behind by a stopped runtime.
        const left = pids.filter(processAlive)
        removeDir(dataDir)
        removeDir(repo)
        expect(left, 'worker processes left behind').toEqual([])
      }
    },
    (MINUTES + 30) * 60_000,
  )
})
