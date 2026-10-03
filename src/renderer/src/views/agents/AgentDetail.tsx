import { useState } from 'react'
import type { Agent } from '@shared/domain'
import { useStopAgent } from '../../lib/queries'
import { agentStatus } from '../../lib/status'
import { formatCount } from '../../lib/format'
import { Badge, Button, ConfirmDialog, StatusBadge, StopIcon, Tabs, type TabItem } from '../../components/ui'
import { FilesTab } from './FilesTab'
import { MessagesTab } from './MessagesTab'
import { OutputTab } from './OutputTab'
import { TaskTab } from './TaskTab'
import { ToolsTab } from './ToolsTab'
import { UsageTab } from './UsageTab'

type TabId = 'output' | 'tools' | 'files' | 'messages' | 'task' | 'usage'

const STOPPABLE = new Set<Agent['state']>(['starting', 'working', 'waiting', 'blocked'])

/** Detail pane for one agent. The parent keys it by agent id so tab-local state resets on selection. */
export function AgentDetail({ agent }: { agent: Agent }) {
  const [tab, setTab] = useState<TabId>('output')
  const [confirmStop, setConfirmStop] = useState(false)
  const stop = useStopAgent()

  const tabs: TabItem<TabId>[] = [
    { id: 'output', label: 'Output', testId: 'agent-tab-output' },
    { id: 'tools', label: 'Tools', badge: <span className="font-mono text-[0.8rem] text-fg-faint">{formatCount(agent.metrics.toolCalls)}</span>, testId: 'agent-tab-tools' },
    { id: 'files', label: 'Files', testId: 'agent-tab-files' },
    { id: 'messages', label: 'Messages', testId: 'agent-tab-messages' },
    { id: 'task', label: 'Task', testId: 'agent-tab-task' },
    { id: 'usage', label: 'Usage', testId: 'agent-tab-usage' },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-detail">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-surface-1 px-3 py-2">
        <span className="text-[1.05rem] font-semibold">{agent.label}</span>
        <StatusBadge status={agentStatus(agent.state)} />
        <Badge mono>{agent.role}</Badge>
        {agent.model ? <Badge mono>{agent.model}</Badge> : null}
        <span className="min-w-0 flex-1 truncate text-fg-muted">{agent.activity ?? ''}</span>
        <Button
          size="sm"
          variant="danger"
          icon={<StopIcon size={12} />}
          disabled={!STOPPABLE.has(agent.state)}
          onClick={() => setConfirmStop(true)}
          data-testid="agent-stop"
        >
          Stop agent
        </Button>
      </header>
      {agent.error ? (
        <div role="alert" className="shrink-0 border-b border-l-2 border-l-tone-danger bg-tone-danger/10 px-3 py-1.5 text-tone-danger">
          {agent.error}
        </div>
      ) : null}
      <Tabs tabs={tabs} active={tab} onChange={setTab} className="px-2" />
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'output' ? <OutputTab agent={agent} /> : null}
        {tab === 'tools' ? <ToolsTab agent={agent} /> : null}
        {tab === 'files' ? <FilesTab agent={agent} /> : null}
        {tab === 'messages' ? <MessagesTab agent={agent} /> : null}
        {tab === 'task' ? <TaskTab agent={agent} /> : null}
        {tab === 'usage' ? <UsageTab agent={agent} /> : null}
      </div>
      <ConfirmDialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        onConfirm={() => {
          stop.mutate({ agentId: agent.id }, { onSettled: () => setConfirmStop(false) })
        }}
        title={`Stop ${agent.label}?`}
        confirmLabel="Stop agent"
        danger
        loading={stop.isPending}
      >
        The agent session is interrupted and closed. Its task is not marked completed.
      </ConfirmDialog>
    </div>
  )
}
