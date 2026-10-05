import { useState } from 'react'
import type { MemoryEntry, MemoryScope, MemoryStatus } from '@shared/domain'
import { assertNever } from '@shared/result'
import { useAddMemory, useDeleteMemory, useMemory, useSetMemoryStatus } from '../../lib/queries'
import { useDebounced } from '../../lib/useDebounced'
import { formatDateTime, shortId } from '../../lib/format'
import type { StatusInfo } from '../../lib/status'
import { cn } from '../../lib/cn'
import { useCurrentProject } from '../../app/useCurrent'
import {
  Badge,
  Button,
  CheckIcon,
  CodeBlock,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  KeyValue,
  Loading,
  Markdown,
  PageHeader,
  MemoryIcon,
  PlusIcon,
  SearchIcon,
  Select,
  StatusBadge,
  Textarea,
  Toggle,
  TrashIcon,
  XIcon,
  type KeyValueRow,
} from '../../components/ui'

type ScopeFilter = MemoryScope | 'all'
type StatusFilter = MemoryStatus | 'all'

function memoryStatus(status: MemoryStatus): StatusInfo {
  switch (status) {
    case 'proposed':
      return { label: 'Proposed', tone: 'review' }
    case 'approved':
      return { label: 'Approved', tone: 'success' }
    case 'rejected':
      return { label: 'Rejected', tone: 'neutral' }
    default:
      return assertNever(status, 'memory status')
  }
}

function Provenance({ entry }: { entry: MemoryEntry }) {
  const rows: KeyValueRow[] = [
    { label: 'Source', value: entry.source },
    { label: 'Created', value: formatDateTime(entry.createdAt), mono: true },
  ]
  if (entry.runId) rows.push({ label: 'Run', value: shortId(entry.runId), mono: true })
  if (entry.taskId) rows.push({ label: 'Task', value: shortId(entry.taskId), mono: true })
  if (entry.agentId) rows.push({ label: 'Agent', value: shortId(entry.agentId), mono: true })
  if (entry.filePaths.length > 0) rows.push({ label: 'Files', value: entry.filePaths.join('\n'), mono: true })
  return (
    <div className="flex flex-col gap-2 text-code">
      <KeyValue rows={rows} labelWidth="5rem" />
      {entry.evidence ? (
        <div>
          <div className="mb-1 text-text-secondary">Evidence</div>
          <CodeBlock maxHeight={160}>{entry.evidence}</CodeBlock>
        </div>
      ) : (
        <div className="text-text-muted">No evidence recorded.</div>
      )}
    </div>
  )
}

function MemoryRow({ entry, onDelete }: { entry: MemoryEntry; onDelete: () => void }) {
  const setStatus = useSetMemoryStatus()
  const [open, setOpen] = useState(entry.status === 'proposed')
  const st = memoryStatus(entry.status)
  return (
    <li
      data-testid={`memory-${entry.id}`}
      className={cn('border-b border-l-2 px-5 py-2.5', entry.status === 'proposed' ? 'border-l-tone-review' : 'border-l-transparent')}
    >
      <div className="flex items-center gap-2">
        <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {entry.title}
        </button>
        <StatusBadge status={st} />
        <Badge mono>{entry.scope}</Badge>
        <Badge mono>{entry.kind}</Badge>
        {entry.status === 'proposed' ? (
          <>
            <Button
              size="sm"
              variant="primary"
              icon={<CheckIcon size={12} />}
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ memoryId: entry.id, status: 'approved' })}
              data-testid="memory-approve"
            >
              Approve
            </Button>
            <Button
              size="sm"
              icon={<XIcon size={12} />}
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ memoryId: entry.id, status: 'rejected' })}
              data-testid="memory-reject"
            >
              Reject
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" icon={<TrashIcon size={12} />} onClick={onDelete} data-testid="memory-delete" aria-label={`Delete ${entry.title}`} />
      </div>
      {entry.tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {entry.tags.map((t) => (
            <span key={t} className="font-mono text-caption text-text-muted">
              #{t}
            </span>
          ))}
        </div>
      ) : null}
      {open ? (
        <div className="mt-2 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Markdown>{entry.content}</Markdown>
          <Provenance entry={entry} />
        </div>
      ) : null}
    </li>
  )
}

function AddMemoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useCurrentProject()
  const add = useAddMemory()
  const [scope, setScope] = useState<'global' | 'project'>('project')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const effectiveScope = scope === 'project' && !project ? 'global' : scope
  const valid = title.trim().length > 0 && content.trim().length > 0

  const submit = () => {
    add.mutate(
      {
        scope: effectiveScope,
        ...(effectiveScope === 'project' && project ? { projectId: project.id } : {}),
        title: title.trim(),
        content: content.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 20),
      },
      {
        onSuccess: () => {
          setTitle('')
          setContent('')
          setTags('')
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add memory entry"
      width={520}
      testId="add-memory-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={add.isPending} onClick={submit} data-testid="memory-add-submit">
            Add entry
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Scope" hint={project ? `Project scope applies to ${project.name}.` : 'Open a project to add project-scoped memory.'}>
          {(id) => (
            <Select
              id={id}
              value={effectiveScope}
              onChange={setScope}
              options={[
                { value: 'project', label: 'Project', disabled: !project },
                { value: 'global', label: 'Global (all projects)' },
              ]}
            />
          )}
        </Field>
        <Field label="Title">
          {(id) => <Input id={id} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="memory-title" />}
        </Field>
        <Field label="Content" hint="Markdown. State the fact and when it applies.">
          {(id) => <Textarea id={id} rows={6} maxLength={10_000} value={content} onChange={(e) => setContent(e.target.value)} data-testid="memory-content" />}
        </Field>
        <Field label="Tags" hint="Comma separated">
          {(id) => <Input id={id} value={tags} onChange={(e) => setTags(e.target.value)} />}
        </Field>
        <p className="m-0 text-small text-text-muted">Entries you add are recorded with source “user”.</p>
      </div>
    </Dialog>
  )
}

export function MemoryView() {
  const project = useCurrentProject()
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [currentOnly, setCurrentOnly] = useState(false)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<MemoryEntry | null>(null)
  const del = useDeleteMemory()

  const query = useDebounced(search.trim(), 250)
  const memory = useMemory({
    query,
    scope: scope === 'all' ? null : scope,
    projectId: currentOnly ? (project?.id ?? null) : null,
  })

  const entries = (memory.data ?? [])
    .filter((e) => status === 'all' || e.status === status)
    // Proposed entries need a decision, so they come first; newest first inside each group.
    .sort((a, b) => Number(b.status === 'proposed') - Number(a.status === 'proposed') || b.createdAt.localeCompare(a.createdAt))
  const proposed = (memory.data ?? []).filter((e) => e.status === 'proposed').length

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="memory-view">
      <PageHeader
        title="Memory"
        context="System"
        actions={
          <Button variant="primary" icon={<PlusIcon size={12} />} onClick={() => setAdding(true)} data-testid="memory-add">
            Add entry
          </Button>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-surface px-5 py-2">
        <div className="relative w-64">
          <SearchIcon size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            aria-label="Search memory"
            className="pl-6"
            placeholder="Search memory"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="memory-search"
          />
        </div>
        <Select
          aria-label="Scope"
          className="w-32!"
          value={scope}
          onChange={setScope}
          data-testid="memory-scope"
          options={[
            { value: 'all', label: 'All scopes' },
            { value: 'global', label: 'Global' },
            { value: 'project', label: 'Project' },
            { value: 'run', label: 'Run' },
          ]}
        />
        <Select
          aria-label="Status"
          className="w-36!"
          value={status}
          onChange={setStatus}
          data-testid="memory-status"
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'proposed', label: `Proposed${proposed ? ` (${proposed})` : ''}` },
            { value: 'approved', label: 'Approved' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <Toggle checked={currentOnly} onChange={setCurrentOnly} disabled={!project} label={project ? `Only ${project.name}` : 'Only current project'} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        {memory.isPending ? (
          <Loading label="Loading memory" />
        ) : memory.isError ? (
          <ErrorNote error={memory.error} className="m-5" />
        ) : entries.length === 0 ? (
          <EmptyState title={query || scope !== 'all' || status !== 'all' ? 'No matching memory' : 'No memory yet'} icon={<MemoryIcon size={22} />}>
            Agents propose durable facts about a project while they work. Proposals wait here for your approval; add your own at any time.
          </EmptyState>
        ) : (
          <ul className="m-0 list-none p-0">
            {entries.map((e) => (
              <MemoryRow key={e.id} entry={e} onDelete={() => setDeleting(e)} />
            ))}
          </ul>
        )}
      </div>

      <AddMemoryDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) del.mutate({ memoryId: deleting.id }, { onSuccess: () => setDeleting(null) })
        }}
        loading={del.isPending}
        title="Delete memory entry?"
        confirmLabel="Delete"
        danger
      >
        “{deleting?.title}” is removed permanently and will no longer be given to agents.
      </ConfirmDialog>
    </div>
  )
}
