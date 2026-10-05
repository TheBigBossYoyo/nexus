import { useState } from 'react'
import type { WorkspaceDetail } from '@shared/workspace'
import { useRemoveWorkspace, useWorkspace } from '../../lib/queries-v5'
import { Button, ChevronLeftIcon, ConfirmDialog, ErrorNote, PageHeader, Tabs, TrashIcon } from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { ContractsTab } from './ContractsTab'
import { GraphTab } from './GraphTab'
import { MemoryTab } from './MemoryTab'
import { MissionsTab } from './MissionsTab'
import { OverviewTab } from './OverviewTab'
import { PolicyTab } from './PolicyTab'
import { ReleasesTab } from './ReleasesTab'
import { activeMissions } from './workspacesModel'

export type WorkspaceTab = 'overview' | 'graph' | 'contracts' | 'missions' | 'releases' | 'memory' | 'policy'

const count = (n: number) => <span className="tnum text-text-muted">{n}</span>

export function WorkspacePage({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const q = useWorkspace(workspaceId)
  const remove = useRemoveWorkspace()
  const [tab, setTab] = useState<WorkspaceTab>('overview')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const d: WorkspaceDetail | undefined = q.data

  const back = (
    <Button size="sm" variant="ghost" icon={<ChevronLeftIcon size={13} />} onClick={onBack} data-testid="workspace-back">
      All workspaces
    </Button>
  )

  if (!d) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="workspace-page">
        <PageHeader title="Workspace" context="Workspaces" actions={back} />
        <div className="min-h-0 flex-1 overflow-auto p-6" data-testid={q.isError ? 'workspace-error' : 'workspace-loading'}>
          {q.isPending ? <BlockSkeleton rows={5} /> : q.isError ? <ReadError error={q.error} calm="This workspace is not available yet." onRetry={() => void q.refetch()} /> : null}
        </div>
      </div>
    )
  }

  const w = d.workspace
  const tabs = [
    { id: 'overview', label: 'Overview', badge: count(d.repositories.length) },
    { id: 'graph', label: 'Graph', badge: count(d.dependencies.length) },
    { id: 'contracts', label: 'Contracts', badge: count(d.contracts.length) },
    { id: 'missions', label: 'Missions', badge: count(d.missions.length) },
    { id: 'releases', label: 'Release trains', badge: count(d.releaseTrains.length) },
    { id: 'memory', label: 'Memory & decisions', badge: count(d.memory.length) },
    { id: 'policy', label: 'Policy' },
  ] as const

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-page" data-workspace-id={w.id}>
      <PageHeader
        title={w.name}
        context="Workspaces"
        actions={
          <>
            {back}
            <Button size="sm" variant="danger" icon={<TrashIcon size={12} />} onClick={() => setConfirmRemove(true)} data-testid="workspace-remove">
              Remove workspace
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-6 py-5">
          {w.description ? (
            <p className="m-0 text-text-secondary" data-testid="workspace-description-text">
              {w.description}
            </p>
          ) : null}
          {activeMissions(d.missions).length > 0 ? (
            <p className="m-0 text-small text-text-muted" role="status">
              {activeMissions(d.missions).length} mission(s) in progress.
            </p>
          ) : null}
          <Tabs
            label="Workspace sections"
            active={tab}
            onChange={setTab}
            tabs={tabs.map((t) => ({
              id: t.id,
              label: t.label,
              ...('badge' in t ? { badge: t.badge } : {}),
              testId: `workspace-tab-${t.id}`,
              domId: `workspace-tabbtn-${t.id}`,
              controls: `workspace-panel-${t.id}`,
            }))}
          />
          <div role="tabpanel" id={`workspace-panel-${tab}`} aria-labelledby={`workspace-tabbtn-${tab}`} tabIndex={0} className="rounded-md outline-offset-2">
            {tab === 'overview' ? (
              <OverviewTab detail={d} />
            ) : tab === 'graph' ? (
              <GraphTab detail={d} />
            ) : tab === 'contracts' ? (
              <ContractsTab detail={d} />
            ) : tab === 'missions' ? (
              <MissionsTab detail={d} onOpenReleases={() => setTab('releases')} />
            ) : tab === 'releases' ? (
              <ReleasesTab detail={d} />
            ) : tab === 'memory' ? (
              <MemoryTab detail={d} />
            ) : (
              <PolicyTab detail={d} />
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove this workspace?"
        confirmLabel="Remove workspace"
        danger
        loading={remove.isPending}
        testId="workspace-remove-dialog"
        onConfirm={() =>
          remove.mutate(
            { workspaceId },
            {
              onSuccess: () => {
                setConfirmRemove(false)
                onBack()
              },
            },
          )
        }
      >
        The workspace, its dependency graph, contracts, missions and release plans are forgotten. The repository folders themselves are not changed.
        {remove.isError ? <ErrorNote error={remove.error} className="mt-2" /> : null}
      </ConfirmDialog>
    </div>
  )
}
