import type { ReactNode } from 'react'
import type { ArenaTrialDetail } from '@shared/v3-read'
import { useUiStore } from '../../store/ui'
import { useArenaTrial } from '../../lib/queries-v3'
import { formatDateTime, formatDuration, shortId } from '../../lib/format'
import { Badge, Button, CodeBlock, Drawer, ExternalIcon, KeyValue } from '../../components/ui'
import { BlockSkeleton, Caption, ReadError } from '../usage/shared'
import { TrialStateText } from './TrialGlyph'
import { metricGroups, strategyName, trialStateInfo } from './arenaModel'

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <Caption>{title}</Caption>
      {children}
    </section>
  )
}

function Body({ d, onClose }: { d: ArenaTrialDetail; onClose: () => void }) {
  const openRun = useUiStore((s) => s.openRun)
  const t = d.trial
  const ev = d.evaluation
  const info = trialStateInfo(t.state)
  const groups = metricGroups(d.metrics)
  const models = Object.entries(t.models)
  return (
    <div data-testid="arena-trial-detail">
      <Block title="Trial">
        <KeyValue
          labelWidth="8rem"
          rows={[
            { label: 'Case', value: d.case?.case.name ?? shortId(t.caseId) },
            { label: 'Strategy', value: strategyName(t.strategy) },
            { label: 'Repetition', value: String(t.repetition) },
            { label: 'State', value: <TrialStateText state={t.state} detail /> },
            {
              label: 'Baseline commit',
              value: t.baselineCommit ? t.baselineCommit.slice(0, 10) : '—',
              mono: true,
            },
            {
              label: 'Result commit',
              value: t.resultCommit ? t.resultCommit.slice(0, 10) : '—',
              mono: true,
            },
            { label: 'Started', value: formatDateTime(t.startedAt) },
            { label: 'Finished', value: formatDateTime(t.finishedAt) },
            {
              label: 'Models',
              value:
                models.length === 0 ? (
                  <span className="text-text-muted">Not resolved yet</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {models.map(([role, m]) => (
                      <Badge key={role} tone="neutral" mono title={role}>
                        {role.replace(/_/g, ' ')}: {m}
                      </Badge>
                    ))}
                  </span>
                ),
            },
          ]}
        />
        {t.detail && info.terminal && t.state !== 'passed' ? (
          <p className="m-0 text-small text-text-secondary">{t.detail}</p>
        ) : null}
        {t.runId ? (
          <div>
            <Button
              size="sm"
              icon={<ExternalIcon size={12} />}
              data-testid="arena-open-run"
              onClick={() => {
                onClose()
                openRun(t.runId!, t.projectId ?? undefined)
              }}
            >
              Open run in Mission Control
            </Button>
          </div>
        ) : null}
      </Block>

      <Block title="Hidden evaluation">
        {ev ? (
          <div className="flex flex-col gap-2" data-testid="arena-evaluation">
            <div className="flex items-center gap-2">
              <Badge tone={ev.passed ? 'success' : 'danger'}>
                {ev.passed ? 'Passed' : 'Failed'}
              </Badge>
              {ev.timedOut ? <Badge tone="warning">Timed out</Badge> : null}
            </div>
            <KeyValue
              labelWidth="8rem"
              rows={[
                {
                  label: 'Exit code',
                  value: ev.exitCode === null ? 'None' : String(ev.exitCode),
                  mono: true,
                },
                { label: 'Duration', value: formatDuration(ev.durationMs) },
                { label: 'Command', value: ev.command, mono: true },
                ...(ev.skippedReason
                  ? [{ label: 'Not run because', value: ev.skippedReason }]
                  : []),
              ]}
            />
            {ev.output ? (
              <CodeBlock maxHeight={200}>{ev.output}</CodeBlock>
            ) : (
              <p className="m-0 text-small text-text-muted">The evaluator printed no output.</p>
            )}
          </div>
        ) : (
          <p className="m-0 text-text-muted">
            No evaluation recorded{t.state === 'queued' || info.glyph === 'running' ? ' yet' : ''}.
          </p>
        )}
      </Block>

      <Block title="Raw metrics">
        {groups.length === 0 ? (
          <p className="m-0 text-text-muted">No metrics recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-3" data-testid="arena-metrics">
            {groups.map((g) => (
              <div key={g.title}>
                <h4 className="m-0 mb-1 text-small font-semibold text-text-primary">{g.title}</h4>
                <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5">
                  {g.items.map((i) => (
                    <div key={i.label} className="contents">
                      <dt className="text-text-secondary">{i.label}</dt>
                      <dd
                        className={`m-0 text-right tnum ${i.measured ? (i.bad ? 'font-medium text-danger' : 'text-text-primary') : 'text-text-muted'}`}
                      >
                        {i.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </Block>

      <Block title="Convenience score">
        {ev ? (
          <div className="flex flex-col gap-1.5" data-testid="arena-score">
            <p className="m-0 text-text-secondary">
              <span className="tnum text-text-primary">{Math.round(ev.score)}</span> of 100 (
              {ev.scoreVersion}). A summary for sorting only: it is 0 whenever acceptance failed and
              never replaces the raw metrics above.
            </p>
            {Object.keys(ev.scoreBreakdown).length > 0 ? (
              <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 text-small text-text-muted">
                {Object.entries(ev.scoreBreakdown).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>{k.replace(/_/g, ' ')}</dt>
                    <dd className="m-0 text-right tnum">{Math.round(v * 10) / 10}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>
        ) : (
          <p className="m-0 text-text-muted">No score yet.</p>
        )}
      </Block>
    </div>
  )
}

export function TrialDrawer({ trialId, onClose }: { trialId: string | null; onClose: () => void }) {
  const q = useArenaTrial(trialId)
  return (
    <Drawer
      open={!!trialId}
      onClose={onClose}
      title="Trial record"
      width={520}
      testId="arena-trial-drawer"
    >
      {q.isPending ? (
        <div className="p-4">
          <BlockSkeleton rows={6} />
        </div>
      ) : q.isError ? (
        <div className="p-4">
          <ReadError
            error={q.error}
            calm="This trial is not available yet."
            onRetry={() => void q.refetch()}
          />
        </div>
      ) : (
        <Body d={q.data} onClose={onClose} />
      )}
    </Drawer>
  )
}
