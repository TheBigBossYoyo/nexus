import { useEffect, useRef } from 'react'
import { usePendingApprovals } from '../../lib/queries'
import { useUiStore } from '../../store/ui'
import { Button, CheckIcon } from '../../components/ui'

/** Persistent strip under the header while anything awaits a human decision. Dark text on a pale amber tint (AA). */
export function ApprovalBar() {
  const pending = usePendingApprovals().data ?? []
  const setDrawer = useUiStore((s) => s.setDrawer)
  const first = pending[0]
  if (!first) return null
  return (
    <div
      data-testid="approval-bar"
      role="status"
      className="flex min-h-8 shrink-0 items-center gap-3 border-b bg-surface-muted px-5 py-0.5 text-small"
    >
      <CheckIcon size={13} className="shrink-0 text-text-secondary" />
      <span className="font-semibold text-text-primary">
        {pending.length} approval{pending.length === 1 ? '' : 's'} pending
      </span>
      <span className="min-w-0 flex-1 truncate text-text-secondary">
        {first.action}
        {first.command ? `: ${first.command}` : ''}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setDrawer('approvals')} data-testid="approval-bar-review">
        Review
      </Button>
    </div>
  )
}

/**
 * Opens the drawer when an approval id appears that this session has not seen. The first successful load only
 * seeds the set: approvals that were already pending at startup are shown by the bar, not forced open.
 */
export function useAutoOpenApprovals(): void {
  const data = usePendingApprovals().data
  const seen = useRef<Set<string> | null>(null)
  const setDrawer = useUiStore((s) => s.setDrawer)
  useEffect(() => {
    if (!data) return
    if (seen.current === null) {
      seen.current = new Set(data.map((a) => a.id))
      return
    }
    const known = seen.current
    // Plan approvals are answered in the run view's plan panel; the drawer would only cover it.
    const fresh = data.filter((a) => !known.has(a.id) && a.kind !== 'plan')
    for (const a of data) known.add(a.id)
    if (fresh.length > 0) setDrawer('approvals')
  }, [data, setDrawer])
}
