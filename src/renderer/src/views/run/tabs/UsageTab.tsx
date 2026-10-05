import { useState } from 'react'
import { SegmentedControl, SourceLabel, Stat } from '../../../components/ui'
import { formatCount, formatDuration, formatTokens } from '../../../lib/format'
import { useRunUsage } from '../../../lib/queries-run'
import { pauseSummary, usageRows, type UsageRowView } from '../missionModel'
import { useNow, useRunCtx } from '../runContext'

const OBSERVED = { confidence: 'OBSERVED', source: 'LOCAL_AGGREGATION' } as const

function Table({ title, rows }: { title: string; rows: UsageRowView[] }) {
  return (
    <section className="min-w-0">
      <h3 className="m-0 mb-1 flex items-center gap-2 text-heading font-semibold">
        {title}
        <SourceLabel confidence="OBSERVED" source="LOCAL_AGGREGATION" />
      </h3>
      {rows.length === 0 ? (
        <p className="m-0 text-small text-text-muted">Nothing recorded yet.</p>
      ) : (
        <table className="w-full border-collapse text-left text-small">
          <thead>
            <tr className="text-caption text-text-muted">
              <th scope="col" className="h-6 border-b font-medium">
                Name
              </th>
              <th scope="col" className="h-6 border-b px-2 text-right font-medium">
                Sessions
              </th>
              <th scope="col" className="h-6 border-b px-2 text-right font-medium">
                Turns
              </th>
              <th scope="col" className="h-6 border-b px-2 text-right font-medium">
                Input
              </th>
              <th scope="col" className="h-6 border-b px-2 text-right font-medium">
                Output
              </th>
              <th scope="col" className="h-6 border-b text-right font-medium">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b last:border-b-0">
                <td className="max-w-[16rem] truncate py-1" title={r.label}>
                  {r.label}
                </td>
                <td className="tnum px-2 text-right">{r.sessions}</td>
                <td className="tnum px-2 text-right">{r.turns}</td>
                <td className="tnum px-2 text-right">{r.input}</td>
                <td className="tnum px-2 text-right">{r.output}</td>
                <td className="tnum text-right">{r.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** Observed Claude usage of this run. Counts only: never a percentage of a subscription. */
export function RunUsageTab() {
  const { detail } = useRunCtx()
  const query = useRunUsage(detail.run.id)
  const now = useNow(false)
  const [by, setBy] = useState<'agent' | 'model' | 'role'>('agent')
  if (query.isPending)
    return (
      <div className="p-3 text-small text-text-muted" role="status">
        Loading usage…
      </div>
    )
  if (query.isError)
    return (
      <div className="p-3 text-small text-text-muted" data-testid="run-usage-unavailable">
        Usage for this mission is not available yet. Nothing is wrong with the mission itself.
      </div>
    )
  const u = query.data
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4" data-testid="run-usage">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Stat label="Input tokens" value={formatTokens(u.totals.inputTokens)} source={OBSERVED} />
        <Stat label="Output tokens" value={formatTokens(u.totals.outputTokens)} source={OBSERVED} />
        <Stat label="Sessions" value={formatCount(u.totals.sessions)} source={OBSERVED} />
        <Stat label="Turns" value={formatCount(u.totals.turns)} source={OBSERVED} />
        <Stat label="Agent time" value={formatDuration(u.totals.durationMs)} source={OBSERVED} />
      </div>
      <div className="flex flex-col gap-2">
        <SegmentedControl
          size="sm"
          label="Group usage by"
          className="self-start"
          value={by}
          onChange={setBy}
          options={[
            { value: 'agent', label: 'By agent' },
            { value: 'model', label: 'By model' },
            { value: 'role', label: 'By role' },
          ]}
        />
        {by === 'agent' ? <Table title="By agent" rows={usageRows(u.byAgent)} /> : null}
        {by === 'model' ? <Table title="By model" rows={usageRows(u.byModel)} /> : null}
        {by === 'role' ? <Table title="By role" rows={usageRows(u.byRole)} /> : null}
      </div>
      <section>
        <h3 className="m-0 mb-1 text-heading font-semibold">Quota pauses</h3>
        {u.pauses.length === 0 ? (
          <p className="m-0 text-small text-text-muted">This mission has not been paused by a usage limit.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="run-quota-pauses">
            {u.pauses.map((p) => (
              <li key={p.id} className="rounded-md border p-2 text-small">
                <div className="font-medium">{pauseSummary(p, now)}</div>
                {p.resumes.length > 0 ? (
                  <ul className="m-0 mt-1 list-none p-0 text-text-secondary">
                    {p.resumes.map((r) => (
                      <li key={r.id}>
                        {r.kind === 'probe' ? 'Probe' : 'Resume'}: {r.result.replace(/_/g, ' ')}
                        {r.detail ? ` (${r.detail})` : ''}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
