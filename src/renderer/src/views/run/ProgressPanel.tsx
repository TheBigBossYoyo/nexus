import { useQuery } from '@tanstack/react-query'
import { progressRows, type ProgressSnapshot } from '@shared/progress'
import { Button } from '../../components/ui'
import { api, type IpcError } from '../../lib/bridge'
import { useUiStore } from '../../store/ui'

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

const clock = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ProgressPanel({ runId }: { runId: string }) {
  const { data: s } = useProgress(runId)
  const setDrawer = useUiStore((st) => st.setDrawer)
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
      {/* 0.9.1: the owner read "waiting for your decision" and found nothing to decide: the inbox opens only from the status bar. */}
      {(s.wait === 'WAITING_FOR_USER_BOUNDARY' || /boundary request/i.test(s.stage)) && (
        <p className="progress-scope" role="status">
          <Button size="sm" onClick={() => setDrawer('boundary')} data-testid="progress-open-boundary">
            Open the boundary request
          </Button>
        </p>
      )}
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
