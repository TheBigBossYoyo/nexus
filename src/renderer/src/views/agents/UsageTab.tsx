import type { Agent, AgentSession, Handoff } from '@shared/domain'
import { useAgentDetail } from '../../lib/queries'
import { DASH, formatCost, formatCount, formatDateTime, formatTokens } from '../../lib/format'
import { Badge, ErrorNote, KeyValue, Loading } from '../../components/ui'
import { agentElapsed } from './agentLogic'
import { RoutingSection } from './RoutingSection'
import { useNow } from './useNow'

const HANDOFF_SECTIONS: { key: keyof Handoff; label: string }[] = [
  { key: 'completedWork', label: 'Completed work' },
  { key: 'commits', label: 'Commits' },
  { key: 'filesChanged', label: 'Files changed' },
  { key: 'unresolvedIssues', label: 'Unresolved issues' },
  { key: 'importantFindings', label: 'Important findings' },
  { key: 'nextSteps', label: 'Next steps' },
]

function HandoffView({ handoff }: { handoff: Handoff }) {
  return (
    <div className="mt-1 flex flex-col gap-1.5 border-l-2 border-tone-review pl-3" data-testid="session-handoff">
      <div className="text-[0.75rem] font-semibold uppercase tracking-wider text-tone-review">Handoff</div>
      {HANDOFF_SECTIONS.map(({ key, label }) => {
        const items = handoff[key]
        if (items.length === 0) return null
        return (
          <div key={key}>
            <div className="text-[0.85rem] text-fg-muted">{label}</div>
            <ul className="m-0 list-disc pl-5">
              {items.map((item, i) => (
                <li key={`${i}:${item}`} className="break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

function SessionRow({ session }: { session: AgentSession }) {
  return (
    <li className="flex flex-col gap-1 border-b py-2" data-testid="agent-session">
      <div className="flex items-center gap-2">
        <Badge tone={session.state === 'active' ? 'active' : session.state === 'failed' ? 'danger' : 'neutral'}>{session.state}</Badge>
        <span className="font-mono text-[0.92em]">{session.model ?? DASH}</span>
        <span className="ml-auto font-mono text-[0.85rem] text-fg-faint">{formatDateTime(session.startedAt)}</span>
      </div>
      <KeyValue
        labelWidth="7rem"
        rows={[
          { label: 'Session id', value: session.sdkSessionId ?? DASH, mono: true },
          { label: 'Ended', value: formatDateTime(session.endedAt) },
          { label: 'End reason', value: session.endReason ?? DASH },
        ]}
      />
      {session.handoff ? <HandoffView handoff={session.handoff} /> : null}
    </li>
  )
}

export function UsageTab({ agent }: { agent: Agent }) {
  const query = useAgentDetail(agent.id)
  const now = useNow(agent.stoppedAt === null && agent.startedAt !== null)
  const m = agent.metrics
  const sessions = query.data?.sessions ?? []
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3" data-testid="agent-usage">
      <KeyValue
        rows={[
          { label: 'Model', value: agent.model ?? DASH, mono: true },
          { label: 'Started', value: formatDateTime(agent.startedAt) },
          { label: 'Elapsed', value: agentElapsed(agent, now), mono: true },
          { label: 'Turns', value: formatCount(m.turns), mono: true },
          { label: 'Tool calls', value: formatCount(m.toolCalls), mono: true },
          { label: 'Commands', value: formatCount(m.commands), mono: true },
          { label: 'Files read', value: formatCount(m.filesRead), mono: true },
          { label: 'Files changed', value: formatCount(m.filesChanged), mono: true },
          { label: 'Input tokens', value: formatTokens(m.inputTokens), mono: true },
          { label: 'Output tokens', value: formatTokens(m.outputTokens), mono: true },
          { label: 'Cache-read tokens', value: formatTokens(m.cacheReadTokens), mono: true },
          { label: 'Est. cost (runtime)', value: formatCost(m.costUsd), mono: true },
          { label: 'Context window', value: formatTokens(m.contextWindow), mono: true },
        ]}
      />
      <p className="m-0 text-[0.85rem] text-fg-faint">
        {DASH} means the runtime has not reported that value. Token counts are the latest report from the runtime. Cost is
        the runtime's own list-price estimate, not an invoice: with a Claude subscription it is not what you are charged.
      </p>
      <RoutingSection agent={agent} />
      <section>
        <h3 className="m-0 mb-1 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">Sessions · {sessions.length}</h3>
        {query.isError ? <ErrorNote error={query.error} /> : null}
        {query.isPending ? <Loading label="Loading sessions" /> : null}
        {query.isSuccess && sessions.length === 0 ? <div className="text-fg-faint">No sessions recorded.</div> : null}
        <ul className="m-0 list-none p-0">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </ul>
      </section>
    </div>
  )
}
