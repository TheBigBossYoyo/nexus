import type { StrategyComparisonRow } from '@shared/v3'
import type { ArenaResults } from '@shared/v3-read'
import { useArenaResults } from '../../lib/queries-v3'
import { Badge, EmptyState, Notice } from '../../components/ui'
import { BlockSkeleton, Caption, ReadError } from '../usage/shared'
import { ComparisonTable } from './ComparisonTable'
import { intervalText, passText, pct, sortComparison, strategyName, whiskers } from './arenaModel'

const AXIS_W = 260

/** Pass rate per strategy with its 95% Wilson interval as a whisker. The axis always runs 0 to 100%. */
export function PassRateChart({ rows }: { rows: readonly StrategyComparisonRow[] }) {
  const sorted = sortComparison(rows)
  const ws = whiskers(sorted, AXIS_W)
  return (
    <div className="flex flex-col gap-1" data-testid="arena-pass-chart">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {sorted.map((r, i) => {
          const w = ws[i]!
          const label = `${strategyName(r.strategy)}: ${r.n === 0 ? 'no finished trials' : `pass rate ${pct(r.passRate)}, 95% interval ${intervalText(r.passInterval)}, n ${r.n}`}`
          return (
            <li key={r.strategy} className="grid grid-cols-[6.5rem_272px_auto] items-center gap-3">
              <span className="font-medium">{strategyName(r.strategy)}</span>
              <svg
                role="img"
                aria-label={label}
                width={AXIS_W + 12}
                height={20}
                viewBox={`-6 0 ${AXIS_W + 12} 20`}
                className="block"
              >
                <line
                  x1={0}
                  x2={AXIS_W}
                  y1={10}
                  y2={10}
                  className="stroke-border"
                  strokeWidth={1}
                />
                {[0, 0.5, 1].map((t) => (
                  <line
                    key={t}
                    x1={t * AXIS_W}
                    x2={t * AXIS_W}
                    y1={5}
                    y2={15}
                    className="stroke-border-strong"
                    strokeWidth={1}
                  />
                ))}
                {w.hasInterval ? (
                  <line
                    x1={w.low}
                    x2={w.high}
                    y1={10}
                    y2={10}
                    className="stroke-text-secondary"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                  />
                ) : null}
                {w.rate !== null ? (
                  <circle
                    cx={w.x}
                    cy={10}
                    r={4}
                    className="fill-accent stroke-surface"
                    strokeWidth={1.5}
                  />
                ) : null}
              </svg>
              <span className="tnum text-small text-text-secondary">
                {r.n === 0 ? 'n 0' : `${passText(r.passed, r.n, r.passRate)}`}
              </span>
            </li>
          )
        })}
      </ul>
      <div
        className="grid grid-cols-[6.5rem_272px_auto] gap-3 text-caption text-text-muted"
        aria-hidden="true"
      >
        <span />
        <span className="flex justify-between" style={{ width: AXIS_W, marginLeft: 6 }}>
          <span>0%</span>
          <span>50%</span>
          <span>100%</span>
        </span>
        <span />
      </div>
      <p className="m-0 mt-1 text-small text-text-muted">
        Dot: observed pass rate. Whisker: 95% Wilson interval. When whiskers overlap, the evidence
        does not separate the strategies.
      </p>
    </div>
  )
}

function ResultsBody({ r }: { r: ArenaResults }) {
  if (r.totalTrials === 0 || r.comparison.length === 0)
    return (
      <EmptyState title="No finished trials yet" className="py-8" data-testid="arena-results-empty">
        Results appear here as trials finish.
      </EmptyState>
    )
  return (
    <div className="flex flex-col gap-5">
      {r.regressions.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="arena-regressions">
          {r.regressions.map((f) => (
            <Notice
              key={`${f.strategy}-${f.current.group}`}
              tone={f.verdict === 'established' ? 'danger' : 'warning'}
              title={f.label}
            >
              {strategyName(f.strategy)}: {pct(f.current.passRate)} in {f.current.group} (n{' '}
              {f.current.n}, {intervalText(f.current.interval)}) against {pct(f.baseline.passRate)}{' '}
              in {f.baseline.group} (n {f.baseline.n}, {intervalText(f.baseline.interval)}).
              {f.verdict === 'established'
                ? ' The intervals do not overlap.'
                : ' The intervals overlap, so the drop is not established.'}
            </Notice>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Caption>Pass rate by strategy · {r.totalTrials} trials</Caption>
        <PassRateChart rows={r.comparison} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Caption>Strategy comparison</Caption>
        <ComparisonTable rows={r.comparison} />
      </div>
      {r.notes.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="arena-notes">
          {r.notes.map((n, i) => (
            <li key={i} className="flex gap-2 text-text-secondary">
              <span aria-hidden="true" className="text-text-muted">
                ·
              </span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {r.byCase.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Caption>By case</Caption>
          <div className="flex flex-col rounded-lg border bg-surface">
            {r.byCase.map((c) => (
              <details key={c.caseId} className="group border-b last:border-b-0">
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-3 py-1.5 hover:bg-surface-muted">
                  <span
                    aria-hidden="true"
                    className="text-text-muted transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                  <span className="font-medium">{c.caseName}</span>
                  <Badge tone="neutral">{c.rows.reduce((n, x) => n + x.n, 0)} trials</Badge>
                </summary>
                <div className="px-3 pb-3">
                  <ComparisonTable
                    rows={c.rows}
                    caption={`Strategy comparison for ${c.caseName}`}
                  />
                </div>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function ResultsPanel({ campaignId }: { campaignId: string }) {
  const q = useArenaResults(campaignId)
  return (
    <div data-testid="arena-results">
      {q.isPending ? (
        <BlockSkeleton rows={4} />
      ) : q.isError ? (
        <ReadError
          error={q.error}
          calm="Results are not available yet."
          onRetry={() => void q.refetch()}
        />
      ) : (
        <ResultsBody r={q.data} />
      )}
    </div>
  )
}
