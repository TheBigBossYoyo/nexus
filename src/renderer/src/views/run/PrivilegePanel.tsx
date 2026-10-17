import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PrivilegeSessionStatus, PrivilegedOperationReceipt, PrivilegedOutcome } from '@shared/privilege'
import { PRIVILEGE_SESSION_NOTICE } from '@shared/privilege'
import { Badge, Button, Dialog, Markdown } from '../../components/ui'
import { api, type IpcError } from '../../lib/bridge'

/**
 * 0.9.1: ADMIN ACCESS on the mission page (B16). Whether a privilege session serves this run, the one button that
 * prepares it (one UAC prompt, Windows' own), the one that ends it, and the privileged activity of the run: every
 * attempt, the refused ones too, with the full report a click away. Nothing is asked for a trivial task: the panel
 * offers the session, it never prepares one by itself.
 */

export const privilegeKey = ['privilege'] as const

const OUTCOME_TONE: Record<PrivilegedOutcome, 'success' | 'danger' | 'warning' | 'neutral'> = {
  EXECUTED: 'success',
  FAILED: 'danger',
  TIMEOUT: 'danger',
  DECLINED_BY_OWNER: 'neutral',
  EXECUTING: 'warning',
  ABORTED: 'warning',
  REJECTED_BY_POLICY: 'warning',
  REJECTED_BY_DIRECTOR: 'warning',
}

const clock = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function PrivilegePanel({ runId, live }: { runId: string; live: boolean }) {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: [...privilegeKey, 'status'], queryFn: () => api.invoke('privilege.status', {}), retry: false, refetchInterval: 60_000 })
  const activity = useQuery<{ receipts: PrivilegedOperationReceipt[]; report: string }, IpcError>({ queryKey: [...privilegeKey, 'activity', runId], queryFn: () => api.invoke('privilege.activity', { runId }), retry: false, refetchInterval: 60_000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  if (!status.data?.available) return null
  const active: PrivilegeSessionStatus | null = status.data.active
  const mine = active !== null && active.runId === runId ? active : null
  const receipts = activity.data?.receipts ?? []
  // A finished run with no privileged history needs no panel.
  if (!live && mine === null && receipts.length === 0) return null
  const refresh = () => void qc.invalidateQueries({ queryKey: privilegeKey })
  const prepare = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await api.invoke('privilege.prepare', { scope: 'MISSION', runId })
      if (!out.ok) setError(out.reason ?? 'The session could not be prepared.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      refresh()
    }
  }
  const revoke = async () => {
    setBusy(true)
    try {
      await api.invoke('privilege.revoke', {})
    } finally {
      setBusy(false)
      refresh()
    }
  }
  return (
    <section className="privilege-panel" aria-label="Administrator access for this mission" data-testid="privilege-panel">
      <div className="privilege-head">
        <span className="privilege-title">Admin access</span>
        {mine ? (
          <Badge tone="active" data-testid="privilege-state">
            ACTIVE — {mine.scope === 'OVERNIGHT' ? 'Overnight scope' : 'Mission scope'} until {clock(mine.expiresAt)}
          </Badge>
        ) : (
          <Badge tone="neutral" data-testid="privilege-state">
            NOT ACTIVE{active ? ' (another session is active)' : ''}
          </Badge>
        )}
        {mine && !mine.elevated && <Badge tone="warning">not elevated (test mode)</Badge>}
        <span className="privilege-actions">
          {live && mine === null && active === null && (
            <Button size="sm" onClick={() => void prepare()} loading={busy} data-testid="privilege-prepare" title={PRIVILEGE_SESSION_NOTICE}>
              Prepare for this Mission
            </Button>
          )}
          {mine && (
            <Button size="sm" variant="ghost" onClick={() => void revoke()} loading={busy} data-testid="privilege-revoke">
              End admin access
            </Button>
          )}
          {receipts.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setReportOpen(true)} data-testid="privilege-report-open">
              Privileged activity ({receipts.length})
            </Button>
          )}
        </span>
      </div>
      {live && mine === null && active === null && <p className="privilege-note">{PRIVILEGE_SESSION_NOTICE}</p>}
      {status.data.uacWarning && (
        <p className="privilege-error" role="note" data-testid="privilege-uac-warning">
          {status.data.uacWarning}
        </p>
      )}
      {error && (
        <p className="privilege-error" role="alert" data-testid="privilege-error">
          {error}
        </p>
      )}
      {receipts.length > 0 && (
        <ul className="privilege-list" data-testid="privilege-list">
          {receipts.slice(-5).map((r) => (
            <li key={r.id}>
              <span className="privilege-time">{clock(r.requestedAt)}</span>
              <Badge tone={OUTCOME_TONE[r.outcome]}>{r.outcome.replace(/_/g, ' ')}</Badge>
              <span className="privilege-goal">{r.goal || '(no goal given)'}</span>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={reportOpen} onClose={() => setReportOpen(false)} title="Privileged activity" width={820} testId="privilege-report-dialog">
        <Markdown>{activity.data?.report ?? ''}</Markdown>
      </Dialog>
    </section>
  )
}
