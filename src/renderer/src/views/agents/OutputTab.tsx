import { useLayoutEffect, useRef, useState } from 'react'
import type { Agent, AgentOutput } from '@shared/domain'
import { useAgentOutput } from '../../lib/queries'
import { useLiveText } from '../../store/live'
import { clockTime } from './agentLogic'
import { Button, EmptyState, ErrorNote, Loading, Markdown } from '../../components/ui'

function OutputItem({ item }: { item: AgentOutput }) {
  const stamp = <span className="font-mono text-[0.75rem] text-fg-faint">{clockTime(item.createdAt)}</span>
  switch (item.kind) {
    case 'error':
      return (
        <div data-testid="output-error" className="border-l-2 border-tone-danger bg-tone-danger/10 px-3 py-1.5">
          <div className="flex items-center gap-2 text-[0.75rem] font-semibold uppercase text-tone-danger">Error {stamp}</div>
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.92em] text-tone-danger">{item.content}</pre>
        </div>
      )
    case 'user':
      return (
        <div className="border-l-2 border-tone-review bg-surface-2 px-3 py-1.5">
          <div className="flex items-center gap-2 text-[0.75rem] font-semibold uppercase text-tone-review">Instruction {stamp}</div>
          <pre className="m-0 whitespace-pre-wrap break-words font-sans">{item.content}</pre>
        </div>
      )
    case 'system':
      return (
        <div className="flex gap-2 px-3 text-[0.9em] text-fg-faint">
          {stamp}
          <pre className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono">{item.content}</pre>
        </div>
      )
    case 'text':
      return (
        <div className="px-3">
          {stamp}
          <Markdown>{item.content}</Markdown>
        </div>
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
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  const items = query.data
  return (
    <div className="relative min-h-0 flex-1" data-testid="agent-output">
      <div ref={scroller} onScroll={onScroll} className="flex h-full flex-col gap-2 overflow-auto py-2">
        {items.length === 0 && !live ? (
          <EmptyState title="No output yet">Output appears here as the agent produces it.</EmptyState>
        ) : null}
        {items.map((item) => (
          <OutputItem key={item.id} item={item} />
        ))}
        {live ? (
          <div className="px-3" data-testid="output-live">
            <span className="text-[0.75rem] font-semibold uppercase text-tone-active">Streaming</span>
            <pre className="m-0 whitespace-pre-wrap break-words font-sans">{live}</pre>
          </div>
        ) : null}
      </div>
      {!following ? (
        <Button size="sm" variant="primary" className="absolute bottom-3 right-4 shadow-lg" onClick={jump} data-testid="output-jump">
          Jump to latest
        </Button>
      ) : null}
    </div>
  )
}
