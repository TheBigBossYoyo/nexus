import { useQuery } from '@tanstack/react-query'
import { formatElapsed, type ProgressSnapshot } from '@shared/progress'
import { api, type IpcError } from '../../lib/bridge'

/**
 * 0.9: how far a mission is, what it is doing, and how much active work remains. Everything shown here is the
 * runtime's computation (`progress.get`); nothing is estimated in the window. A wait is said as a wait: the
 * time remaining is active work, and the panel does not pretend to know when a wait ends.
 */

export const progressKey = (runId: string) => ['progress', runId] as const

export function useProgress(runId: string | null) {
  return useQuery<ProgressSnapshot | null, IpcError>({
    queryKey: progressKey(runId ?? ''),
    queryFn: () => api.invoke('progress.get', { runId: runId ?? '' }),
    enabled: runId !== null,
    retry: false,
    // The runtime pushes a snapshot when something changes; this is only the floor under that.
    refetchInterval: 60_000,
  })
}

const CONFIDENCE_TEXT: Record<ProgressSnapshot['eta']['confidence'], string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' }

const clock = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The rows of the panel as plain values, so that what is shown can be tested without a window. */
export function progressRows(s: ProgressSnapshot): { label: string; value: string }[] {
  const waiting = s.wait !== 'ACTIVE' && s.wait !== 'FINISHED'
  const rows = [
    { label: 'Elapsed', value: formatElapsed(s.elapsedSeconds) },
    { label: s.wait === 'FINISHED' ? 'Remaining' : 'Active work remaining', value: s.eta.text },
  ]
  if (s.wait !== 'FINISHED' && s.eta.lowSeconds !== null) rows.push({ label: 'Confidence', value: s.eta.uncertainty ? `${CONFIDENCE_TEXT[s.eta.confidence]}: ${s.eta.uncertainty}` : CONFIDENCE_TEXT[s.eta.confidence] })
  rows.push({ label: 'Tasks', value: `${s.tasks.completed} of ${s.tasks.total} done${s.tasks.failed > 0 ? `, ${s.tasks.failed} failed` : ''}` })
  if (s.wait !== 'FINISHED') rows.push({ label: 'Workers', value: `${s.workers.active} active, ${s.workers.waiting} waiting` })
  rows.push({ label: 'Blockers', value: s.blocker ?? 'none' })
  if (waiting) rows.push({ label: 'On the clock', value: 'not known while it waits' })
  if (s.lastEvent) rows.push({ label: 'Last event', value: `${clock(s.lastEvent.at)} ${s.lastEvent.text}` })
  if (s.nextRefreshAt) rows.push({ label: 'Next refresh', value: clock(s.nextRefreshAt) })
  return rows
}

export function ProgressPanel({ runId }: { runId: string }) {
  const { data: s } = useProgress(runId)
  if (!s || s.tasks.total === 0) return null
  const waiting = s.wait !== 'ACTIVE' && s.wait !== 'FINISHED'
  return (
    <section className={`progress-panel${waiting ? ' progress-panel-waiting' : ''}`} aria-label="Progress of this mission" data-testid="progress-panel">
      <div className="progress-head">
        <span className="progress-percent" data-testid="progress-percent">
          {s.percent}%
        </span>
        <span className="progress-stage" data-testid="progress-stage">
          {s.stage}
        </span>
      </div>
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={s.percent} aria-valuetext={`${s.percent} percent. ${s.summary}`}>
        <div className="progress-bar-fill" style={{ width: `${s.percent}%` }} />
      </div>
      <p className="progress-summary" data-testid="progress-summary">
        {s.summary}
      </p>
      {s.scopeChange && (
        <p className="progress-scope" role="status" data-testid="progress-scope">
          {s.scopeChange}
        </p>
      )}
      <dl className="progress-rows">
        {progressRows(s).map((row) => (
          <div key={row.label} className="progress-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {s.milestones.length > 0 && (
        <details className="progress-feed">
          <summary>Milestones ({s.milestones.length})</summary>
          <ol>
            {[...s.milestones].reverse().map((m, i) => (
              <li key={`${m.at}-${i}`}>
                <time dateTime={m.at}>{clock(m.at)}</time> {m.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
