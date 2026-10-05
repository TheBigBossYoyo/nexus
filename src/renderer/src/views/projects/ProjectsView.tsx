import { useProjects, useOpenProject } from '../../lib/queries'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../store/ui'
import {
  Badge,
  BranchIcon,
  Button,
  EmptyState,
  ErrorNote,
  FolderIcon,
  Loading,
  PageHeader,
  PlusIcon,
  TimeAgo,
} from '../../components/ui'
import { PanelGroup, ResizablePanel, ResizeHandle } from '../../components/ui/Resizable'
import { useCurrentProject } from '../../app/useCurrent'
import { MissionComposer } from './MissionComposer'
import { ProjectDetail } from './ProjectDetail'

export function ProjectsView() {
  const projects = useProjects()
  const current = useCurrentProject()
  const selectProject = useUiStore((s) => s.selectProject)
  const open = useOpenProject()

  const openProject = () =>
    open.mutate(
      {},
      {
        onSuccess: (project) => {
          if (project) selectProject(project.id)
        },
      },
    )

  const openButton = (testId: string) => (
    <Button
      variant="primary"
      icon={<PlusIcon size={12} />}
      loading={open.isPending}
      onClick={openProject}
      data-testid={testId}
    >
      Open Project
    </Button>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Projects" context="Workspace" actions={openButton('open-project')} />
      <div className="min-h-0 flex-1">
        <PanelGroup id="projects">
          <ResizablePanel id="projects-list" defaultSize="320px" minSize="240px" maxSize="520px">
            <div className="flex h-full min-h-0 flex-col bg-surface">
              <div className="min-h-0 flex-1 overflow-auto" data-testid="project-list">
                {projects.isPending ? (
                  <Loading label="Loading projects" />
                ) : projects.isError ? (
                  <ErrorNote error={projects.error} className="m-3" />
                ) : projects.data.length === 0 ? (
                  <EmptyState title="No projects yet" icon={<FolderIcon size={22} />}>
                    Open a Git repository to profile it and start a mission. NEXUS never writes to
                    your working tree; agents work in separate worktrees.
                  </EmptyState>
                ) : (
                  <ul className="m-0 list-none p-0">
                    {projects.data.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          data-testid={`project-${p.id}`}
                          onClick={() => selectProject(p.id)}
                          aria-current={current?.id === p.id ? 'true' : undefined}
                          className={cn(
                            'flex w-full flex-col gap-0.5 border-b px-4 py-2.5 text-left transition-colors hover:bg-surface-muted',
                            current?.id === p.id && 'bg-accent-subtle hover:bg-accent-subtle',
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium">{p.name}</span>
                            {p.profile?.dirty ? <Badge tone="warning">dirty</Badge> : null}
                            <TimeAgo
                              iso={p.lastOpenedAt}
                              className="ml-auto shrink-0 text-small text-text-muted"
                            />
                          </span>
                          <span className="truncate font-mono text-code text-text-muted">
                            {p.rootPath}
                          </span>
                          {p.profile?.currentBranch ? (
                            <span className="inline-flex items-center gap-1 font-mono text-code text-text-secondary">
                              <BranchIcon size={11} />
                              {p.profile.currentBranch}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </ResizablePanel>
          <ResizeHandle />
          <ResizablePanel id="projects-detail" minSize="360px">
            <div className="h-full overflow-auto bg-background p-5">
              {current ? (
                <div className="mx-auto flex max-w-3xl flex-col gap-4">
                  <MissionComposer key={`composer-${current.id}`} project={current} />
                  <ProjectDetail key={current.id} project={current} />
                </div>
              ) : (
                <EmptyState
                  title="Select or open a project"
                  icon={<FolderIcon size={22} />}
                  action={openButton('open-project-secondary')}
                >
                  A project is a Git repository NEXUS can run missions against.
                </EmptyState>
              )}
            </div>
          </ResizablePanel>
        </PanelGroup>
      </div>
    </div>
  )
}
