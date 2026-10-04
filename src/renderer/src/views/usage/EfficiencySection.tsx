import type { StrategyEfficiencyRow, UsageEfficiency } from '@shared/v3-read'
import { formatCount, formatDuration, formatTokens } from '../../lib/format'
import { useUsageEfficiency } from '../../lib/queries-v3'
import { Badge, Card, DataTable, MeasuredValue, type Column } from '../../components/ui'
import { evidenceTone } from '../arena/arenaModel'
import { efficiencyGroups, strategyTitle } from './usageViewModel'
import { BlockSkeleton, Caption, ReadError, TableFrame } from './shared'

const columns: Column<StrategyEfficiencyRow>[] = [
  {
    key: 's',
    header: 'Strategy',
    render: (r) => <span className="font-medium">{strategyTitle(r.strategy)}</span>,
  },
  { key: 'n', header: 'n', numeric: true, render: (r) => formatCount(r.n) },
  { key: 'pass', header: 'Passed', numeric: true, render: (r) => `${r.successes}/${r.n}` },
  {
    key: 'sess',
    header: 'Mean sessions',
    numeric: true,
    render: (r) => (r.meanSessions === null ? '—' : r.meanSessions.toFixed(1)),
  },
  {
    key: 'tok',
    header: 'Mean observed tokens',
    numeric: true,
    render: (r) => formatTokens(r.meanObservedTokens),
  },
  {
    key: 'time',
    header: 'Median time',
    numeric: true,
    render: (r) => formatDuration(r.medianDurationMs),
  },
  {
    key: 'label',
    header: 'Evidence',
    render: (r) => (
      <Badge tone={evidenceTone(r.label)}>
        {r.label.charAt(0) + r.label.slice(1).toLowerCase()}
      </Badge>
    ),
  },
]

function Body({ e }: { e: UsageEfficiency }) {
  const groups = efficiencyGroups(e.byStrategy)
  return (
    <div className="flex flex-col gap-5">
      <div
        className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-3"
        data-testid="usage-efficiency-measures"
      >
        <Metric label="Observed tokens per successful task">
          <MeasuredValue
            measured={e.tokensPerSuccessfulTask}
            format={(v) => formatTokens(v)}
            unknownReason="No completed task yet"
          />
        </Metric>
        <Metric label="Sessions per successful task">
          <MeasuredValue
            measured={e.sessionsPerSuccessfulTask}
            format={(v) => v.toFixed(1)}
            unknownReason="No completed task yet"
          />
        </Metric>
        <Metric label="Repairs per task">
          <MeasuredValue
            measured={e.repairsPerTask}
            format={(v) => v.toFixed(1)}
            unknownReason="No completed task yet"
          />
        </Metric>
      </div>
      <p className="m-0 text-small text-text-muted">
        {e.successfulTasks} successful task{e.successfulTasks === 1 ? '' : 's'} counted. Tokens are
        what NEXUS observed in its own sessions.
      </p>
      {groups.map((g) => (
        <div
          key={g.kind}
          className="flex flex-col gap-1.5"
          data-testid={`usage-efficiency-${g.kind}`}
        >
          <Caption>{g.title}</Caption>
          <TableFrame>
            <DataTable
              columns={columns}
              rows={g.rows}
              rowKey={(r) => `${r.kind}-${r.strategy}`}
              caption={g.title}
            />
          </TableFrame>
        </div>
      ))}
      {groups.length === 0 ? (
        <p className="m-0 text-text-muted">No strategy has recorded outcomes yet.</p>
      ) : null}
    </div>
  )
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-small text-text-muted">{label}</div>
      <div className="text-[1.23rem] font-semibold leading-6">{children}</div>
    </div>
  )
}

export function EfficiencySection() {
  const q = useUsageEfficiency()
  return (
    <Card
      title="Efficiency"
      description="Arena trials are controlled experiments; real missions are observational. They are never pooled."
      data-testid="usage-efficiency"
    >
      {q.isPending ? (
        <BlockSkeleton rows={3} />
      ) : q.isError ? (
        <ReadError
          error={q.error}
          calm="Efficiency figures are not available yet."
          onRetry={() => void q.refetch()}
        />
      ) : (
        <Body e={q.data} />
      )}
    </Card>
  )
}
