import { useEffect, useRef } from 'react'
import { usePendingApprovals } from '../../lib/queries'
import { useUiStore } from '../../store/ui'

/** Persistent amber strip across the top of the content area while anything awaits a human decision. */
export function ApprovalBar() {
  const pending = usePendingApprovals().data ?? []
  const setDrawer = useUiStore((s) => s.setDrawer)
  const first = pending[0]
  if (!first) return null
  return (
    <div
      data-testid="approval-bar"
      role="status"
      className="flex h-8 shrink-0 items-center gap-3 border-b border-tone-waiting bg-tone-waiting px-3 text-accent-fg"
    >
      <span className="font-semibold">
        {pending.length} approval{pending.length === 1 ? '' : 's'} pending
      </span>
      <span className="min-w-0 flex-1 truncate opacity-80">
        {first.action}
        {first.command ? `: ${first.command}` : ''}
      </span>
      <button
        type="button"
        data-testid="approval-bar-review"
        onClick={() => setDrawer('approvals')}
        className="h-6 rounded-[3px] border border-accent-fg/50 bg-accent-fg/10 px-2 font-medium hover:bg-accent-fg/20"
      >
        Review
      </button>
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
