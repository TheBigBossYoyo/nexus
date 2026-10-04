import { Fragment, useState } from 'react'
import type { PolicyContextRow } from '@shared/v3-read'
import { formatDuration } from '../../lib/format'
import { Badge, Card, ChevronDownIcon, ChevronRightIcon, EmptyState } from '../../components/ui'
import {
  evidenceText,
  evidenceTone,
  intervalText,
  meanText,
  strategyName,
} from '../arena/arenaModel'
import { evidenceRowText, formatContextKey } from './policyModel'

function Detail({ row }: { row: PolicyContextRow }) {
  return (
    <div className="px-3 pb-3 pl-9">
      <table
        className="w-full border-collapse text-left"
        aria-label={`Evidence for ${formatContextKey(row.contextKey)}`}
      >
        <thead>
          <tr className="text-caption text-text-muted">
            {[
              'Strategy',
              'Arena passed',
              'Missions passed',
              '95% interval',
              'Mean sessions',
              'Median time',
              'Evidence',
            ].map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`h-7 border-b px-2 font-medium ${i > 0 && i < 6 ? 'text-right' : ''}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row.rows.map((r) => {
            const t = evidenceRowText(r)
            return (
              <tr
                key={r.strategy}
                className={`border-b last:border-b-0 ${r.suppressed ? 'text-text-muted' : ''}`}
              >
                <td className="px-2 py-1 font-medium">
                  {strategyName(r.strategy)}
                  {r.suppressed ? (
                    <Badge
                      tone="warning"
                      className="ml-2"
                      title="Not offered for this context because of its evidence"
                    >
                      Suppressed
                    </Badge>
                  ) : null}
                </td>
                <td className="tnum px-2 py-1 text-right">{t.arena}</td>
                <td className="tnum px-2 py-1 text-right">{t.missions}</td>
                <td className="tnum px-2 py-1 text-right">{intervalText(r.passInterval)}</td>
                <td className="tnum px-2 py-1 text-right">{meanText(r.meanSessions)}</td>
                <td className="tnum px-2 py-1 text-right">{formatDuration(r.medianDurationMs)}</td>
                <td className="px-2 py-1">
                  <Badge tone={evidenceTone(r.label)}>{evidenceText(r.label)}</Badge>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="m-0 mt-1.5 text-small text-text-muted">
        Arena counts are controlled trials. Mission counts are observational and weighted less.
      </p>
    </div>
  )
}

const HEADERS: { label: string; right?: boolean }[] = [
  { label: 'Context' },
  { label: 'Preferred' },
  { label: 'Default' },
  { label: 'Arena n', right: true },
  { label: 'Missions n', right: true },
  { label: 'Confidence' },
  { label: 'Reason' },
]

export function ContextsTable({ rows }: { rows: readonly PolicyContextRow[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  return (
    <Card
      title="Task contexts"
      description="What the active policy picks for each kind of task, and the evidence behind it."
      padded={false}
      bodyClassName="px-0 pb-0 pt-2"
      data-testid="policy-contexts"
    >
      {rows.length === 0 ? (
        <EmptyState title="No evidence yet" className="py-8">
          Contexts appear after Arena trials or real missions have been recorded. Until then the
          default policy applies everywhere.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" aria-label="Policy by task context">
            <thead>
              <tr>
                {HEADERS.map((h) => (
                  <th
                    key={h.label}
                    scope="col"
                    className={`h-[var(--row-h)] whitespace-nowrap border-y bg-surface-muted px-3 text-caption font-medium text-text-muted ${h.right ? 'text-right' : ''}`}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const expanded = open.has(r.contextKey)
                const changed = r.defaultStrategy !== r.preferred
                return (
                  <Fragment key={r.contextKey}>
                    <tr
                      className="border-b hover:bg-surface-muted"
                      data-testid={`policy-context-${r.contextKey}`}
                    >
                      <td className="px-3 py-1.5">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? 'Hide' : 'Show'} evidence for ${formatContextKey(r.contextKey)}`}
                          onClick={() => toggle(r.contextKey)}
                          className="inline-flex items-center gap-1.5 rounded-sm text-left font-medium"
                        >
                          {expanded ? (
                            <ChevronDownIcon size={12} className="text-text-muted" />
                          ) : (
                            <ChevronRightIcon size={12} className="text-text-muted" />
                          )}
                          {formatContextKey(r.contextKey)}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5">
                        <span className="font-medium">{strategyName(r.preferred)}</span>
                        {r.preference ? (
                          <Badge tone="active" className="ml-2">
                            Learned
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 text-text-secondary">
                        {changed ? (
                          strategyName(r.defaultStrategy)
                        ) : (
                          <span className="text-text-muted">Same</span>
                        )}
                      </td>
                      <td className="tnum px-3 py-1.5 text-right">{r.arenaTrials}</td>
                      <td className="tnum px-3 py-1.5 text-right">{r.missions}</td>
                      <td className="px-3 py-1.5">
                        <Badge tone={evidenceTone(r.label)}>{evidenceText(r.label)}</Badge>
                      </td>
                      <td className="max-w-md px-3 py-1.5 text-text-secondary">
                        <span className="line-clamp-2">{r.reason}</span>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-b bg-surface-muted/50">
                        <td colSpan={HEADERS.length}>
                          <Detail row={r} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
