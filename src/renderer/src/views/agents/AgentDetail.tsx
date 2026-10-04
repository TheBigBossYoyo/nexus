import { useState } from 'react'
import type { Agent } from '@shared/domain'
import { useStopAgent } from '../../lib/queries'
import { agentStatus } from '../../lib/status'
import { formatCount } from '../../lib/format'
import { Button, ConfirmDialog, StatusText, StopIcon, Tabs, type TabItem } from '../../components/ui'
import { agentActivityLine, claudeModelLabel } from './agentLogic'
import { FilesTab } from './FilesTab'
import { MessagesTab } from './MessagesTab'
import { OutputTab } from './OutputTab'
import { SessionTab } from './SessionTab'
import { ToolsTab } from './ToolsTab'
import { UsageTab } from './UsageTab'

type TabId = 'output' | 'tools' | 'files' | 'messages' | 'usage' | 'session'

const STOPPABLE = new Set<Agent['state']>(['starting', 'working', 'waiting', 'blocked'])

/** Detail pane for one agent. The parent keys it by agent id so tab-local state resets on selection. */
export function AgentDetail({ agent }: { agent: Agent }) {
  const [tab, setTab] = useState<TabId>('output')
  const [confirmStop, setConfirmStop] = useState(false)
  const stop = useStopAgent()

  const tabs: TabItem<TabId>[] = [
    { id: 'output', label: 'Output', testId: 'agent-tab-output' },
    {
      id: 'tools',
      label: 'Tools',
      badge: <span className="tnum text-caption text-text-muted">{formatCount(agent.metrics.toolCalls)}</span>,
      testId: 'agent-tab-tools',
    },
    { id: 'files', label: 'Files', testId: 'agent-tab-files' },
    { id: 'messages', label: 'Messages', testId: 'agent-tab-messages' },
    { id: 'usage', label: 'Usage', testId: 'agent-tab-usage' },
    { id: 'session', label: 'Session', testId: 'agent-tab-session' },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="agent-detail">
      <header className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h2 className="m-0 truncate text-heading font-semibold text-text-primary">{agent.label}</h2>
            <StatusText status={agentStatus(agent.state)} className="text-small" />
          </div>
          <div className="text-small text-text-muted">
            <span className="capitalize">{agent.role}</span> · {claudeModelLabel(agent.model)}
            {agent.model ? <span className="font-mono text-code"> ({agent.model})</span> : null}
          </div>
          <div className="mt-0.5 truncate text-small text-text-secondary">{agentActivityLine(agent)}</div>
        </div>
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
        <div role="alert" className="mx-5 mb-2 shrink-0 rounded-md border border-danger/30 bg-danger-subtle px-3 py-1.5 text-small text-danger">
          {agent.error}
        </div>
      ) : null}
      <Tabs tabs={tabs} active={tab} onChange={setTab} label="Agent detail" className="px-4" />
      <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
        {tab === 'output' ? <OutputTab agent={agent} /> : null}
        {tab === 'tools' ? <ToolsTab agent={agent} /> : null}
        {tab === 'files' ? <FilesTab agent={agent} /> : null}
        {tab === 'messages' ? <MessagesTab agent={agent} /> : null}
        {tab === 'usage' ? <UsageTab agent={agent} /> : null}
        {tab === 'session' ? <SessionTab agent={agent} /> : null}
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
