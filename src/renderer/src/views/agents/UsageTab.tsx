import type { Agent } from '@shared/domain'
import { DASH, formatCost, formatCount, formatTokens } from '../../lib/format'
import { useNow } from '../../lib/useNow'
import { SourceLabel, Stat } from '../../components/ui'
import { agentElapsed, claudeModelLabel, observedTokens } from './agentLogic'

/** Observed figures for one agent. Nothing here is a bill or a share of a subscription. */
export function UsageTab({ agent }: { agent: Agent }) {
  const now = useNow(agent.stoppedAt === null && agent.startedAt !== null)
  const m = agent.metrics
  const observed = { confidence: 'OBSERVED' as const, source: 'SDK_EVENT' as const }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-5" data-testid="agent-usage">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        <Stat label="Input tokens" value={formatTokens(m.inputTokens)} source={observed} />
        <Stat label="Output tokens" value={formatTokens(m.outputTokens)} source={observed} />
        <Stat label="Cache-read tokens" value={formatTokens(m.cacheReadTokens)} source={observed} />
        <Stat label="Total (in + out)" value={formatTokens(observedTokens(m))} source={observed} />
        <Stat label="Turns" value={formatCount(m.turns)} source={observed} />
        <Stat label="Tool calls" value={formatCount(m.toolCalls)} source={observed} />
        <Stat label="Files read / changed" value={`${formatCount(m.filesRead)} / ${formatCount(m.filesChanged)}`} />
        <Stat label="Elapsed" value={agentElapsed(agent, now)} />
      </div>
      <dl className="m-0 grid max-w-xl grid-cols-[10rem_1fr] gap-y-1.5 text-body">
        <dt className="text-text-muted">Model</dt>
        <dd className="m-0">
          {claudeModelLabel(agent.model)}
          {agent.model ? <span className="font-mono text-code text-text-muted"> {agent.model}</span> : null}
        </dd>
        <dt className="text-text-muted">Context window</dt>
        <dd className="tnum m-0">
          {formatTokens(m.contextWindow)} <SourceLabel confidence={m.contextWindow === null ? 'UNKNOWN' : 'OBSERVED'} />
        </dd>
        <dt className="text-text-muted">Runtime list-price estimate</dt>
        <dd className="tnum m-0">
          {formatCost(m.costUsd)} <SourceLabel confidence={m.costUsd === null ? 'UNKNOWN' : 'ESTIMATED'} />
        </dd>
      </dl>
      <p className="m-0 max-w-xl text-small text-text-muted">
        Observed means reported by the Claude runtime during this session. {DASH} means it was not reported. The list-price
        estimate is the runtime's own figure, not an invoice: with a Claude subscription it is not what you are charged, and
        NEXUS does not turn token counts into a share of your plan.
      </p>
    </div>
  )
}
