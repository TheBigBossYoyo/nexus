import type { ConcreteStrategy } from '@shared/v3'
import type { ArenaCaseSummary } from '@shared/v3-read'
import type { ArenaCell } from '@shared/v3'
import { cn } from '../../lib/cn'
import { TONE_CLASSES } from '../../lib/status'
import { GlyphIcon } from './TrialGlyph'
import { cellModel, matrixCell, strategyName, trialStateInfo } from './arenaModel'

const LEGEND = ['passed', 'failed', 'running', 'queued', 'blocked', 'cancelled'] as const

/** Rows are cases, columns are strategies; each cell lists its repetitions as icon + number chips. */
export function Matrix({
  cases,
  strategies,
  matrix,
  onOpenTrial,
  selectedTrial,
}: {
  cases: readonly ArenaCaseSummary[]
  strategies: readonly ConcreteStrategy[]
  matrix: readonly ArenaCell[]
  onOpenTrial: (trialId: string) => void
  selectedTrial: string | null
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="arena-matrix">
      <div className="overflow-x-auto rounded-lg border bg-surface">
        <table
          className="w-full border-collapse text-left"
          aria-label="Trial matrix: cases by strategy"
        >
          <thead>
            <tr>
              <th
                scope="col"
                className="h-[var(--row-h)] border-b px-3 text-caption font-medium text-text-muted"
              >
                Case
              </th>
              {strategies.map((s) => (
                <th
                  key={s}
                  scope="col"
                  className="h-[var(--row-h)] border-b border-l px-3 text-caption font-medium text-text-muted"
                >
                  {strategyName(s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr
                key={c.case.id}
                className="border-b last:border-b-0"
                data-testid={`arena-matrix-row-${c.case.id}`}
              >
                <th
                  scope="row"
                  className="min-w-44 max-w-64 px-3 py-2 text-left align-top font-normal"
                >
                  <div className="truncate font-medium">{c.case.name}</div>
                  <div className="text-small text-text-muted">
                    {c.case.category} · {c.case.complexity} · {c.case.risk} risk
                  </div>
                </th>
                {strategies.map((s) => {
                  const m = cellModel(matrixCell(matrix, c.case.id, s))
                  return (
                    <td
                      key={s}
                      className="min-w-32 border-l px-3 py-2 align-top"
                      data-testid={`arena-cell-${c.case.id}-${s}`}
                    >
                      {m.chips.length === 0 ? (
                        <span className="text-text-muted">No trials</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <div className="flex flex-wrap gap-1">
                            {m.chips.map((chip) => (
                              <button
                                key={chip.id}
                                type="button"
                                onClick={() => onOpenTrial(chip.id)}
                                aria-label={`${c.case.name}, ${strategyName(s)}, repetition ${chip.repetition}: ${chip.detail}`}
                                title={`Repetition ${chip.repetition}: ${chip.detail}`}
                                data-testid={`arena-trial-${chip.id}`}
                                data-state={chip.info.glyph}
                                className={cn(
                                  'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-small font-medium transition-colors hover:bg-surface-muted',
                                  TONE_CLASSES[chip.info.tone].text,
                                  selectedTrial === chip.id
                                    ? 'border-accent bg-accent-subtle'
                                    : 'border-border',
                                )}
                              >
                                <GlyphIcon glyph={chip.info.glyph} size={12} />
                                {m.single ? (
                                  chip.info.label
                                ) : (
                                  <span className="tnum">R{chip.repetition}</span>
                                )}
                              </button>
                            ))}
                          </div>
                          {!m.single ? (
                            <span className="tnum text-small text-text-muted">{m.summary}</span>
                          ) : null}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul
        className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-small text-text-muted"
        aria-label="Legend"
      >
        {LEGEND.map((st) => {
          const info = trialStateInfo(st)
          return (
            <li
              key={st}
              className={cn('inline-flex items-center gap-1.5', TONE_CLASSES[info.tone].text)}
            >
              <GlyphIcon glyph={info.glyph} size={12} />
              <span className="text-text-secondary">{info.label}</span>
            </li>
          )
        })}
        <li className="ml-auto">R1, R2… are repetitions. Select one for its full record.</li>
      </ul>
    </div>
  )
}
