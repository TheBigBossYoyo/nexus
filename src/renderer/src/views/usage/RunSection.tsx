import { formatCount, formatDuration, formatTokens } from '../../lib/format'
import { useRuns } from '../../lib/queries'
import { useRunUsage } from '../../lib/queries-v3'
import { useUiStore } from '../../store/ui'
import { Button, Card, Stat } from '../../components/ui'
import { isEmptyTotals, pickCurrentRun, strategyTitle } from './usageViewModel'
import { BlockSkeleton, ReadError } from './shared'

const OBSERVED = { confidence: 'OBSERVED', source: 'LOCAL_AGGREGATION' } as const

export function RunSection() {
  const selected = useUiStore((s) => s.runId)
  const openRun = useUiStore((s) => s.openRun)
  const runs = useRuns(null)
  const runId = pickCurrentRun(selected, runs.data ?? [])
  const usage = useRunUsage(runId)
  const run = (runs.data ?? []).find((r) => r.id === runId) ?? null

  const empty = (
    <p className="m-0 text-small text-text-muted">No mission selected. Open one to see the Claude sessions and tokens NEXUS observed for it.</p>
  )

  let body
  if (!runId) body = empty
  else if (usage.isPending) body = <BlockSkeleton rows={2} testId="usage-run-loading" />
  else if (usage.isError)
    body = (
      <ReadError
        error={usage.error}
        calm="Per-run usage is not available yet."
        onRetry={() => void usage.refetch()}
      />
    )
  else {
    const u = usage.data
    const t = u.totals
    body = isEmptyTotals(t) ? (
      <p className="m-0 py-2 text-text-muted">No usage observed yet for this run.</p>
    ) : (
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Agents" value={formatCount(u.agents)} />
        <Stat label="Sessions" value={formatCount(t.sessions)} source={OBSERVED} />
        <Stat label="Turns" value={formatCount(t.turns)} source={OBSERVED} />
        <Stat label="Time in sessions" value={formatDuration(t.durationMs)} source={OBSERVED} />
        <Stat label="Input tokens" value={formatTokens(t.inputTokens)} source={OBSERVED} />
        <Stat label="Output tokens" value={formatTokens(t.outputTokens)} source={OBSERVED} />
        <Stat
          label="Strategy"
          value={u.strategy ? strategyTitle(u.strategy.resolved) : '—'}
          hint={
            u.strategy && u.strategy.requested !== u.strategy.resolved
              ? `Requested ${strategyTitle(u.strategy.requested)}`
              : u.strategy
                ? undefined
                : 'Not recorded'
          }
        />
        <Stat
          label="Quota events"
          value={formatCount(t.limitEvents)}
          hint={
            u.pauses.length > 0
              ? `${u.pauses.length} pause${u.pauses.length === 1 ? '' : 's'}`
              : undefined
          }
        />
      </div>
    )
  }

  return (
    <Card
      title="Current run"
      description={run ? run.prompt.slice(0, 90) : undefined}
      data-testid="usage-run"
      actions={
        runId ? (
          <Button size="sm" variant="ghost" onClick={() => openRun(runId, run?.projectId)}>
            Open in Mission Control
          </Button>
        ) : undefined
      }
    >
      {body}
    </Card>
  )
}
