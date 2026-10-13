import type { ReportEvent } from '@shared/director-line'
import { formatElapsed, type ProgressSnapshot } from '@shared/progress'

/**
 * 0.9: what the runtime tells the Director Line. It raises events from its own facts (a mission ended, a
 * blocker has lasted, the network has been away, an estimate slipped) with a text composed here from the
 * computed progress. Whether an event is sent, to which channel, and how often, is the line's policy: this
 * raises, the policy decides. No model writes any of these texts.
 */

export interface ReporterDeps {
  report: (event: ReportEvent) => void | Promise<void>
  now: () => number
}

interface Watched {
  name: string
  /** When the present blocker or wait was first seen, and what it was. */
  blockedSince: number | null
  blockedText: string | null
  offlineSince: number | null
  /** The first estimate of the end (on the clock) that was firm enough to be held against later ones. */
  firstEndAt: number | null
  firstRemaining: number | null
  slipReported: number
  lastMinutesRaised: { blocked: number; offline: number }
}

const minutesSince = (from: number, now: number): number => Math.max(0, Math.floor((now - from) / 60_000))

/** A snapshot as two or three plain sentences. The numbers are the estimator's. */
export function statusSentence(name: string, s: ProgressSnapshot): string {
  const tasks = `${s.tasks.completed} of ${s.tasks.total} tasks completed${s.tasks.failed > 0 ? `, ${s.tasks.failed} failed` : ''}.`
  if (s.wait === 'FINISHED') return `${name}: ${s.stage.toLowerCase()}. ${tasks} It took ${formatElapsed(s.elapsedSeconds)}.`
  const blocker = s.blocker !== null ? ` ${s.blocker}.` : ''
  return `${name}: ${s.percent}%, ${s.stage.toLowerCase()}. ${tasks} ${s.summary}${blocker}`.replace(/\.\./g, '.')
}

export class DirectorLineReporter {
  private readonly watched = new Map<string, Watched>()

  constructor(private readonly deps: ReporterDeps) {}

  private of(runId: string, name: string): Watched {
    let w = this.watched.get(runId)
    if (w === undefined) {
      w = { name, blockedSince: null, blockedText: null, offlineSince: null, firstEndAt: null, firstRemaining: null, slipReported: 0, lastMinutesRaised: { blocked: -1, offline: -1 } }
      this.watched.set(runId, w)
    }
    w.name = name
    return w
  }

  private raise(event: ReportEvent): void {
    try {
      void Promise.resolve(this.deps.report(event)).catch(() => undefined)
    } catch {
      // The line being away does not stop the runtime.
    }
  }

  /** A new snapshot of a mission. */
  onProgress(snapshot: ProgressSnapshot, name: string, overnightReport?: string | null): void {
    const runId = snapshot.subject.id
    const now = this.deps.now()
    const at = new Date(now).toISOString()
    const w = this.of(runId, name)

    if (snapshot.wait === 'FINISHED') {
      const failed = snapshot.stage === 'Failed'
      if (w.blockedSince !== null) this.raise({ kind: 'MISSION_BLOCKED', at, subjectId: runId, text: `${name}: no longer blocked.`, resolved: true })
      if (overnightReport != null && overnightReport.trim() !== '') this.raise({ kind: 'MORNING_OVERNIGHT_REPORT', at, subjectId: runId, text: `${statusSentence(name, snapshot)}\n\n${overnightReport.trim().slice(0, 1500)}` })
      else this.raise({ kind: failed ? 'CRITICAL_FAILURE' : 'PROGRAM_COMPLETE', at, subjectId: runId, text: statusSentence(name, snapshot), resolved: !failed })
      this.watched.delete(runId)
      return
    }

    // The network: away since when.
    if (snapshot.wait === 'WAITING_FOR_NETWORK') w.offlineSince ??= now
    else if (w.offlineSince !== null) {
      const minutes = minutesSince(w.offlineSince, now)
      w.offlineSince = null
      w.lastMinutesRaised.offline = -1
      this.raise({ kind: 'NETWORK_OFFLINE', at, subjectId: runId, text: `${name}: the network is back after ${minutes} min; the work goes on. ${snapshot.summary}`, minutes, resolved: true })
    }

    // A blocker or a wait on the user: since when. A boundary request is said at once, as what it is.
    const blocked = snapshot.wait === 'WAITING_FOR_USER_BOUNDARY' || (snapshot.blocker !== null && snapshot.wait !== 'WAITING_FOR_NETWORK')
    if (blocked) {
      if (w.blockedSince === null) {
        w.blockedSince = now
        w.blockedText = snapshot.blocker
        if (snapshot.wait === 'WAITING_FOR_USER_BOUNDARY') this.raise({ kind: 'SECURITY_BOUNDARY_REQUIRED', at, subjectId: runId, text: `${name}: a decision is needed at the machine (a boundary request). It cannot be given from here. ${snapshot.summary}` })
      }
    } else if (w.blockedSince !== null) {
      w.blockedSince = null
      w.blockedText = null
      w.lastMinutesRaised.blocked = -1
      this.raise({ kind: 'MISSION_BLOCKED', at, subjectId: runId, text: `${name}: no longer blocked. ${snapshot.summary}`, resolved: true })
    }

    // The estimate: held against the first firm one. Time spent waiting is not a slip of the estimate.
    if (snapshot.wait === 'ACTIVE' && snapshot.eta.highSeconds !== null && snapshot.eta.confidence !== 'LOW') {
      const endAt = now + snapshot.eta.highSeconds * 1000
      if (w.firstEndAt === null) {
        w.firstEndAt = endAt
        w.firstRemaining = snapshot.eta.highSeconds
      } else if (w.firstRemaining !== null && w.firstRemaining > 0) {
        const slippedMinutes = Math.round((endAt - w.firstEndAt) / 60_000)
        const slippedPercent = Math.round(((endAt - w.firstEndAt) / 1000 / w.firstRemaining) * 100)
        // Raised when it grows past what was last reported by a quarter of the first estimate and ten minutes.
        if (slippedMinutes >= 10 && slippedPercent >= w.slipReported + 25) {
          w.slipReported = slippedPercent
          this.raise({ kind: 'ETA_SLIPPED', at, subjectId: runId, text: `${name}: the end is now expected about ${slippedMinutes} min later than first estimated${snapshot.scopeChange ? ` (${snapshot.scopeChange.replace(/\.$/, '')})` : ''}. ${snapshot.summary}`, slippedMinutes, slippedPercent })
        }
      }
    }

    this.raise({ kind: 'PROGRESS', at, subjectId: runId, text: statusSentence(name, snapshot) })
  }

  /** Once a minute: what has lasted is raised again with how long, at 5, 15, 30, 60 minutes and then hourly. The policy's thresholds decide what is sent. */
  tick(): void {
    const now = this.deps.now()
    const at = new Date(now).toISOString()
    const due = (minutes: number, last: number): boolean => [5, 15, 30, 60].some((m) => minutes >= m && last < m) || (minutes >= 120 && Math.floor(minutes / 60) > Math.floor(Math.max(0, last) / 60))
    for (const [runId, w] of this.watched) {
      if (w.offlineSince !== null) {
        const minutes = minutesSince(w.offlineSince, now)
        if (due(minutes, w.lastMinutesRaised.offline)) {
          w.lastMinutesRaised.offline = minutes
          this.raise({ kind: 'NETWORK_OFFLINE', at, subjectId: runId, text: `${w.name}: no network for ${minutes} min. The work that needs the provider waits and resumes by itself; nothing failed.`, minutes })
        }
      }
      if (w.blockedSince !== null) {
        const minutes = minutesSince(w.blockedSince, now)
        if (due(minutes, w.lastMinutesRaised.blocked)) {
          w.lastMinutesRaised.blocked = minutes
          this.raise({ kind: 'MISSION_BLOCKED', at, subjectId: runId, text: `${w.name}: blocked for ${minutes} min. ${w.blockedText ?? ''}`.trim(), minutes })
        }
      }
    }
  }
}
