import { useLayoutEffect, useRef, useState } from 'react'
import type { Agent, AgentOutput } from '@shared/domain'
import { useAgentOutput } from '../../lib/queries'
import { useLiveText } from '../../store/live'
import { clockTime } from './agentLogic'
import { Button, EmptyState, ErrorNote, Loading } from '../../components/ui'

const BODY = 'm-0 whitespace-pre-wrap break-words font-mono text-code leading-[1.55]'

function Entry({ stamp, label, tone, children, testId }: { stamp: string; label?: string; tone?: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 px-5 py-1.5" data-testid={testId}>
      <span className="tnum pt-px font-mono text-caption text-text-muted">{stamp}</span>
      <div className="min-w-0">
        {label ? <div className={`mb-0.5 text-caption font-medium ${tone ?? 'text-text-muted'}`}>{label}</div> : null}
        {children}
      </div>
    </div>
  )
}

function OutputItem({ item }: { item: AgentOutput }) {
  const stamp = clockTime(item.createdAt)
  switch (item.kind) {
    case 'error':
      return (
        <Entry stamp={stamp} label="Error" tone="text-danger" testId="output-error">
          <pre className={`${BODY} rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-danger`}>{item.content}</pre>
        </Entry>
      )
    case 'user':
      return (
        <Entry stamp={stamp} label="Instruction" tone="text-tone-review">
          <pre className={`${BODY} rounded-md border bg-surface-muted px-3 py-2 text-text-primary`}>{item.content}</pre>
        </Entry>
      )
    case 'system':
      return (
        <Entry stamp={stamp} label="System">
          <pre className={`${BODY} text-text-muted`}>{item.content}</pre>
        </Entry>
      )
    case 'text':
      return (
        <Entry stamp={stamp}>
          <pre className={`${BODY} text-text-primary`}>{item.content}</pre>
        </Entry>
      )
  }
}

/** Persisted output plus the transient streaming text. Auto-scroll pauses while the user is scrolled up. */
export function OutputTab({ agent }: { agent: Agent }) {
  const query = useAgentOutput(agent.id)
  const live = useLiveText(agent.id)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [following, setFollowing] = useState(true)
  const count = query.data?.length ?? 0

  useLayoutEffect(() => {
    const el = scroller.current
    if (stick.current && el) el.scrollTop = el.scrollHeight
  }, [count, live])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    stick.current = near
    setFollowing(near)
  }
  const jump = () => {
    stick.current = true
    setFollowing(true)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  if (query.isPending) return <Loading label="Loading output" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  const items = query.data
  return (
    <div className="relative min-h-0 flex-1 bg-surface" data-testid="agent-output">
      <div ref={scroller} onScroll={onScroll} className="flex h-full flex-col overflow-auto py-2" tabIndex={0} aria-label="Agent output">
        {items.length === 0 && !live ? (
          <EmptyState title="No output yet">Output appears here as the agent produces it.</EmptyState>
        ) : null}
        {items.map((item) => (
          <OutputItem key={item.id} item={item} />
        ))}
        {live ? (
          <Entry stamp="live" label="Streaming" tone="text-info" testId="output-live">
            <pre className={`${BODY} text-text-primary`}>{live}</pre>
          </Entry>
        ) : null}
      </div>
      {!following ? (
        <Button size="sm" variant="primary" className="absolute bottom-3 right-5 shadow-elevated" onClick={jump} data-testid="output-jump">
          Jump to latest
        </Button>
      ) : null}
    </div>
  )
}
