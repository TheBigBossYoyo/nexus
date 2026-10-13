import { useState } from 'react'
import type { CheckCommands, Project } from '@shared/domain'
import { useAutonomyOverview } from '../../lib/queries-autonomy'
import { enrollmentLine } from '../autonomy/autonomyModel'
import { AppSessionsPanel } from '../autonomy/AppSessionsPanel'
import { ResearchPanel } from '../autonomy/ResearchPanel'
import { useRemoveProject, useReprofileProject, useUpdateProject } from '../../lib/queries'
import { DASH, formatBytes, formatCount, formatDateTime } from '../../lib/format'
import { useUiStore } from '../../store/ui'
import {
  Badge,
  Button,
  ConfirmDialog,
  InlineCode,
  KeyValue,
  Notice,
  Card,
  RefreshIcon,
  Toggle,
  TrashIcon,
  type KeyValueRow,
} from '../../components/ui'

function Chips({ items }: { items: readonly string[] }) {
  if (items.length === 0) return <span className="text-fg-faint">{DASH}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((i) => (
        <Badge key={i} mono>
          {i}
        </Badge>
      ))}
    </span>
  )
}

function Commands({ commands }: { commands: CheckCommands }) {
  const rows = (['build', 'test', 'lint', 'typecheck'] as const).map((k) => ({
    key: k,
    cmd: commands[k],
  }))
  if (rows.every((r) => r.cmd === null)) {
    return <span className="text-text-muted">None detected: NEXUS cannot run automatic checks</span>
  }
  return (
    <span className="flex flex-col gap-0.5">
      {rows.map((r) => (
        <span key={r.key} className="flex items-baseline gap-2">
          <span className="w-16 text-fg-muted">{r.key}</span>
          {r.cmd === null ? (
            <span className="text-fg-faint">{DASH}</span>
          ) : (
            <InlineCode>{r.cmd}</InlineCode>
          )}
        </span>
      ))}
    </span>
  )
}

/** One line: how this project stands with autonomy, and the way to the settings for it. */
function AutonomyLine({ projectId }: { projectId: string }) {
  const overview = useAutonomyOverview(projectId)
  const selectProject = useUiStore((s) => s.selectProject)
  const openSettings = useUiStore((s) => s.openSettings)
  const profile = overview.data?.enrollment?.profile ?? null
  const text = overview.isPending
    ? 'Autonomy: loading'
    : overview.isError
      ? 'Autonomy: not available right now.'
      : enrollmentLine(profile)
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3"
      data-testid="project-autonomy"
    >
      <span className="font-medium">Autonomy</span>
      <span
        role="status"
        className="min-w-0 flex-1 text-text-secondary"
        data-testid="project-autonomy-line"
      >
        {text}
      </span>
      <Button
        size="sm"
        onClick={() => {
          selectProject(projectId)
          openSettings('autonomy')
        }}
        data-testid="project-autonomy-open"
      >
        Autonomy settings
      </Button>
    </div>
  )
}

export function ProjectDetail({ project }: { project: Project }) {
  const reprofile = useReprofileProject()
  const update = useUpdateProject()
  const remove = useRemoveProject()
  const selectProject = useUiStore((s) => s.selectProject)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const p = project.profile

  const rows: KeyValueRow[] = p
    ? [
        { label: 'Repository', value: p.repoRoot, mono: true },
        {
          label: 'Branch',
          value: p.isGitRepo ? (
            <span className="inline-flex items-center gap-2">
              <span className="font-mono">{p.currentBranch ?? '(detached)'}</span>
              {p.headCommit ? (
                <span className="font-mono text-fg-faint">{p.headCommit.slice(0, 7)}</span>
              ) : null}
              <Badge tone={p.dirty ? 'warning' : 'success'} data-testid="dirty-badge">
                {p.dirty ? 'dirty' : 'clean'}
              </Badge>
            </span>
          ) : (
            <Badge tone="danger">not a Git repository</Badge>
          ),
        },
        { label: 'Languages', value: <Chips items={p.languages} /> },
        { label: 'Frameworks', value: <Chips items={p.frameworks} /> },
        { label: 'Package managers', value: <Chips items={p.packageManagers} /> },
        { label: 'Check commands', value: <Commands commands={p.commands} /> },
        {
          label: 'CLAUDE.md',
          value: p.hasClaudeMd ? (
            <Badge tone="active">present</Badge>
          ) : (
            <span className="text-fg-muted">not present</span>
          ),
        },
        {
          label: 'Files',
          value: `${formatCount(p.fileCount)} · ${formatBytes(p.sizeBytes)}`,
          mono: true,
        },
        { label: 'Profiled', value: formatDateTime(p.profiledAt), mono: true },
      ]
    : []

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card
        title="Project"
        data-testid="project-detail"
        actions={
          <>
            <Button
              size="sm"
              icon={<RefreshIcon size={12} />}
              loading={reprofile.isPending}
              onClick={() => reprofile.mutate({ projectId: project.id })}
              data-testid="reprofile-project"
            >
              Reprofile
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<TrashIcon size={12} />}
              onClick={() => setConfirmRemove(true)}
              data-testid="remove-project"
            >
              Remove
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="min-w-0">
            <div className="truncate text-heading font-semibold">{project.name}</div>
            <div className="break-all font-mono text-code text-text-muted">{project.rootPath}</div>
          </div>

          {p ? (
            <KeyValue rows={rows} className="items-baseline" />
          ) : (
            <Notice tone="neutral" title="Not profiled yet">
              Reprofile to detect the branch, languages, frameworks and check commands.
            </Notice>
          )}

          <AutonomyLine projectId={project.id} />

          <div className="border-t pt-3">
            <Toggle
              checked={project.respectProjectClaudeConfig}
              disabled={update.isPending}
              onChange={(v) =>
                update.mutate({ projectId: project.id, respectProjectClaudeConfig: v })
              }
              label="Respect project CLAUDE.md / Claude configuration"
              description="Off by default. When on, agent sessions also load this repository's CLAUDE.md and .claude settings, which can change agent behaviour and permissions. NEXUS otherwise isolates agents from them."
              data-testid="respect-claude-config"
            />
          </div>
        </div>

        <ConfirmDialog
          open={confirmRemove}
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => {
            remove.mutate(
              { projectId: project.id },
              {
                onSuccess: () => {
                  setConfirmRemove(false)
                  selectProject(null)
                },
              },
            )
          }}
          loading={remove.isPending}
          title={`Remove ${project.name}?`}
          confirmLabel="Remove project"
          danger
        >
          The project is removed from NEXUS. Files in your repository are not deleted.
        </ConfirmDialog>
      </Card>
      <AppSessionsPanel projectId={project.id} />
      <ResearchPanel projectId={project.id} />
    </div>
  )
}
