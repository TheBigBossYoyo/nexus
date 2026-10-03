import type { Agent } from '@shared/domain'
import { useAgentTools } from '../../lib/queries'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { filesFromToolEvents, type FileUse } from './agentLogic'

function FileList({ title, files, testId }: { title: string; files: FileUse[]; testId: string }) {
  return (
    <section data-testid={testId}>
      <h3 className="m-0 mb-1 text-[0.8rem] font-semibold uppercase tracking-wider text-fg-muted">
        {title} · {files.length}
      </h3>
      {files.length === 0 ? (
        <div className="text-fg-faint">None</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {files.map((f) => (
            <li key={f.path} className="flex gap-2 py-0.5">
              <span className="min-w-0 flex-1 break-all font-mono text-[0.92em]">{f.path}</span>
              <span className="shrink-0 font-mono text-fg-faint">×{f.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Derived from tool inputs, so it reflects what the agent attempted, not what git recorded. */
export function FilesTab({ agent }: { agent: Agent }) {
  const query = useAgentTools(agent.id)
  if (query.isPending) return <Loading label="Loading files" />
  if (query.isError) return <ErrorNote error={query.error} className="m-3" />
  const files = filesFromToolEvents(query.data)
  if (files.read.length === 0 && files.changed.length === 0) return <EmptyState title="No file activity yet" />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
      <FileList title="Changed" files={files.changed} testId="files-changed" />
      <FileList title="Read" files={files.read} testId="files-read" />
      <p className="m-0 text-[0.85rem] text-fg-faint">Derived from Read, Edit, Write and NotebookEdit tool calls.</p>
    </div>
  )
}
