import { useEffect, useState } from 'react'
import { useWorkspaces } from '../../lib/queries-v5'
import { useUiStore } from '../../store/ui'
import { ArrowRightIcon, Button, Card, EmptyState, PageHeader, PlusIcon, WorkspacesIcon } from '../../components/ui'
import { BlockSkeleton, ReadError } from '../usage/shared'
import { NewWorkspaceDialog } from './NewWorkspaceDialog'
import { WorkspacePage } from './WorkspacePage'
import { workspaceCountsText } from './workspacesModel'

/** Workspaces: sets of related repositories that one goal can change together. A workspace opens in place of the list. */
export function WorkspacesView() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const workspaces = useWorkspaces()
  const requested = useUiStore((s) => s.workspaceId)
  const openWorkspace = useUiStore((s) => s.openWorkspace)
  useEffect(() => {
    if (!requested) return
    setWorkspaceId(requested)
    openWorkspace(null)
  }, [requested, openWorkspace])

  if (workspaceId)
    return (
      <div className="h-full" data-testid="workspaces-view">
        <WorkspacePage workspaceId={workspaceId} onBack={() => setWorkspaceId(null)} />
      </div>
    )

  const rows = workspaces.data ?? []
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspaces-view">
      <PageHeader
        title="Workspaces"
        context="Workspace"
        actions={
          <Button size="sm" variant="primary" icon={<PlusIcon size={12} />} onClick={() => setDialog(true)} data-testid="workspaces-new">
            New workspace
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-5">
          {workspaces.isPending ? (
            <BlockSkeleton rows={4} testId="workspaces-loading" />
          ) : workspaces.isError ? (
            <div data-testid="workspaces-error">
              <ReadError error={workspaces.error} calm="Workspaces are not available in this build yet." onRetry={() => void workspaces.refetch()} />
            </div>
          ) : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={<WorkspacesIcon size={22} />}
                title="No workspaces yet"
                data-testid="workspaces-empty"
                action={
                  <Button variant="primary" icon={<PlusIcon size={12} />} onClick={() => setDialog(true)} data-testid="workspaces-new-empty">
                    New workspace
                  </Button>
                }
              >
                A workspace is a set of related Git repositories that one goal can change together, such as a shared library, its backend, its apps and its documentation. NEXUS keeps track of how they depend on
                each other, plans the work in the right order, and checks the repositories together before anything is released.
              </EmptyState>
            </Card>
          ) : (
            <section className="flex flex-col gap-2" aria-label="Workspaces">
              <div className="flex items-end justify-between">
                <h2 className="m-0 text-heading font-semibold">All workspaces</h2>
                <span className="tnum text-small text-text-muted">{rows.length} total</span>
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="workspaces-list">
                {rows.map((r) => (
                  <li key={r.workspace.id}>
                    <button
                      type="button"
                      onClick={() => setWorkspaceId(r.workspace.id)}
                      aria-label={`Open workspace ${r.workspace.name}`}
                      data-testid={`workspace-row-${r.workspace.id}`}
                      className="flex w-full items-start gap-3 rounded-lg border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-muted"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="block min-w-0 truncate text-heading font-semibold">{r.workspace.name}</span>
                        {r.workspace.description ? <p className="m-0 mt-0.5 line-clamp-2 text-text-secondary">{r.workspace.description}</p> : null}
                        <dl className="m-0 mt-2 flex flex-wrap gap-x-5 gap-y-1 text-small text-text-secondary" title={workspaceCountsText(r)}>
                          <div className="flex gap-1">
                            <dt className="text-text-muted">Repositories</dt>
                            <dd className="tnum m-0">{r.repositories}</dd>
                          </div>
                          <div className="flex gap-1">
                            <dt className="text-text-muted">Contracts</dt>
                            <dd className="tnum m-0">{r.contracts}</dd>
                          </div>
                          <div className="flex gap-1">
                            <dt className="text-text-muted">Active missions</dt>
                            <dd className="tnum m-0">{r.activeMissions}</dd>
                          </div>
                        </dl>
                      </div>
                      <ArrowRightIcon size={14} className="mt-1.5 shrink-0 text-text-muted" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      <NewWorkspaceDialog open={dialog} onClose={() => setDialog(false)} onCreated={setWorkspaceId} />
    </div>
  )
}
