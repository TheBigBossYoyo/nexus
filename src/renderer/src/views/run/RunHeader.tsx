import type { RunDetail } from '@shared/ipc'
import { formatSpan, shortId } from '../../lib/format'
import { runStatus } from '../../lib/status'
import { Badge, StatusBadge } from '../../components/ui'

/** Compact run header: mode, state, prompt and task counters. Reusable by the run and agents views. */
export function RunHeader({ detail }: { detail: RunDetail }) {
  const { run, tasks, agents } = detail
  const done = tasks.filter((t) => t.state === 'completed').length
  return (
    <header className="flex flex-col gap-1.5 border-b bg-surface-1 px-4 py-3" data-testid="run-header">
      <div className="flex flex-wrap items-center gap-2">
        <Badge mono>{run.mode.toUpperCase()}</Badge>
        <Badge mono>{run.preset.toUpperCase()}</Badge>
        <StatusBadge status={runStatus(run.state)} />
        <span className="font-mono text-[0.85em] text-fg-faint">{shortId(run.id)}</span>
        <span className="ml-auto font-mono text-[0.85em] text-fg-muted">
          tasks {done}/{tasks.length} · agents {agents.length} · {formatSpan(run.startedAt, run.finishedAt)}
        </span>
      </div>
      <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words">{run.prompt}</p>
      {run.error ? <div className="text-tone-danger">{run.error}</div> : null}
    </header>
  )
}
