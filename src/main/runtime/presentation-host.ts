import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Database } from '../modules/persistence/database'
import { PresenceMeter } from '../modules/presentation/meter'
import { PresentationService } from '../modules/presentation/service'
import { SqlitePresentationStore } from '../modules/presentation/store'

/**
 * 0.9.1: what the runtime gives zero-disturbance testing: the presence meter next to the other native helpers
 * (it watches the owner's desktop for windows and focus taken by what descends from this runtime), the metrics in
 * the database, and the evidence of each application's presentation.
 *
 * The meter runs on Windows when its helper is part of the build. Where agents are scripted (development, tests)
 * it runs only with NEXUS_PRESENCE_METER=1: a test suite's own windows are not a mission's.
 */

export interface PresentationHost {
  service: PresentationService
  stop(): Promise<void>
}

export function createPresentationHost(d: {
  db: Database
  launcherPath: string | undefined
  isPackaged: boolean
  scripted: boolean
  env: Record<string, string | undefined>
  runtimePid: number
  uacPrompts: (runId: string) => number
  quietCommands: () => number
  onChange: (runIds: string[]) => void
  log: (line: string) => void
}): PresentationHost {
  const store = new SqlitePresentationStore(d.db)
  const helper = d.launcherPath !== undefined ? join(dirname(d.launcherPath), 'nexus-presence.exe') : null
  const wanted = process.platform === 'win32' && helper !== null && existsSync(helper) && (d.isPackaged || !d.scripted || d.env['NEXUS_PRESENCE_METER'] === '1') && d.env['NEXUS_PRESENCE_METER'] !== '0'
  const activeRuns = d.db.prepare("SELECT id FROM runs WHERE state NOT IN ('completed', 'failed', 'cancelled', 'paused')")
  let meter: PresenceMeter | null = null
  const service = new PresentationService({ store, measuring: () => meter?.running ?? false, uacPrompts: d.uacPrompts, quietCommands: d.quietCommands, onChange: d.onChange })
  if (wanted && helper !== null) {
    meter = new PresenceMeter({
      helperPath: helper,
      runtimePid: d.runtimePid,
      cwd: dirname(helper),
      activeRuns: () => (activeRuns.all() as { id: string }[]).map((r) => r.id),
      onEvent: (event) => {
        service.record(event)
        if (event.kind !== 'FOCUSED_LATER' && event.kind !== 'NEXUS_CONFIRMATION') d.log(`presentation: ${event.kind} by ${event.process} (${event.windowClass})`)
      },
      log: d.log,
    })
    meter.start()
  }
  return { service, stop: async () => meter?.stop() }
}
