import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { AppSessionView } from '@shared/isolation'
import type { UserDisturbanceMetrics } from '@shared/presentation'
import { Badge, Button, Dialog } from '../../components/ui'
import { api, type IpcError } from '../../lib/bridge'
import { appStateTone, screenshotAlt } from '../autonomy/isolationModel'
import { testEnvironmentKeys, testEnvironmentView } from './testEnvironmentModel'

/**
 * The test environment of a mission: its applications under test and the disturbance measured for the user.
 * Read-only. A screenshot is shown from the kept image; nothing here opens or focuses an application's window.
 */

type Shot = { loading: boolean; dataUrl: string | null; takenAt: string | null; error: string | null }

export function TestEnvironmentPanel({ runId, live }: { runId: string; live: boolean }) {
  const apps = useQuery<AppSessionView[], IpcError>({ queryKey: testEnvironmentKeys.apps(runId), queryFn: () => api.invoke('isolation.apps', {}), retry: false, refetchInterval: 60_000 })
  const metrics = useQuery<UserDisturbanceMetrics, IpcError>({ queryKey: testEnvironmentKeys.metrics(runId), queryFn: () => api.invoke('presentation.metrics', { runId }), retry: false, refetchInterval: 60_000 })
  const [shot, setShot] = useState<Shot | null>(null)
  const view = testEnvironmentView({ runId, live, apps: apps.data, metrics: metrics.data })
  if (view.hidden) return null
  const open = async (appId: string) => {
    setShot({ loading: true, dataUrl: null, takenAt: null, error: null })
    try {
      const out = await api.invoke('isolation.appScreenshot', { appId, index: 0 })
      setShot({ loading: false, dataUrl: out?.dataUrl ?? null, takenAt: out?.takenAt ?? null, error: null })
    } catch (e) {
      setShot({ loading: false, dataUrl: null, takenAt: null, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return (
    <section className="test-env-panel" aria-label="Test environment of this mission" data-testid="test-env-panel">
      <div className="test-env-head">
        <span className="test-env-title">Test environment</span>
      </div>
      {view.apps.length > 0 && (
        <ul className="test-env-apps" data-testid="test-env-apps">
          {view.apps.map((a) => (
            <li key={a.id}>
              <span className="test-env-app-name">{a.name}</span>
              <Badge tone={appStateTone(a.state)}>{a.stateLabel}</Badge>
              <span>{a.mode}</span>
              <span>{a.screenshotsLabel}</span>
              {a.canViewScreenshot && (
                <Button size="sm" variant="ghost" onClick={() => void open(a.id)} data-testid="test-env-screenshot">
                  View latest screenshot
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {view.disturbance.measured ? (
        <dl className="test-env-disturbance" data-testid="test-env-disturbance">
          {view.disturbance.rows.map((r) => (
            <div key={r.key} className="test-env-row">
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="test-env-note" data-testid="test-env-unmeasured">
          {view.disturbance.text}
        </p>
      )}
      <p className="test-env-note">{view.notifications}</p>
      <Dialog open={shot !== null} onClose={() => setShot(null)} title="Latest screenshot" width={820} testId="test-env-screenshot-dialog">
        {shot?.error ? (
          <p role="alert">{shot.error}</p>
        ) : shot?.dataUrl ? (
          <img className="test-env-image" src={shot.dataUrl} alt={screenshotAlt(shot.takenAt ? new Date(shot.takenAt).toLocaleString() : 'at an unknown time')} />
        ) : shot?.loading ? (
          <p>Loading…</p>
        ) : (
          <p>This screenshot is no longer kept.</p>
        )}
      </Dialog>
    </section>
  )
}
