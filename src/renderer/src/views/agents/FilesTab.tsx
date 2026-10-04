import type { Agent } from '@shared/domain'
import { useAgentTools } from '../../lib/queries'
import { EmptyState, ErrorNote, Loading } from '../../components/ui'
import { filesFromToolEvents, type FileUse } from './agentLogic'

function FileList({ title, files, testId }: { title: string; files: FileUse[]; testId: string }) {
  return (
    <section data-testid={testId}>
      <h3 className="m-0 mb-1.5 text-heading font-semibold text-text-primary">
        {title} · {files.length}
      </h3>
      {files.length === 0 ? (
        <div className="text-text-muted">None</div>
      ) : (
        <ul className="m-0 list-none p-0">
          {files.map((f) => (
            <li key={f.path} className="flex gap-2 py-0.5">
              <span className="min-w-0 flex-1 break-all font-mono text-code">{f.path}</span>
              <span className="shrink-0 font-mono text-text-muted">×{f.count}</span>
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
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  const files = filesFromToolEvents(query.data)
  if (files.read.length === 0 && files.changed.length === 0) return <EmptyState title="No file activity yet" />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
      <FileList title="Changed" files={files.changed} testId="files-changed" />
      <FileList title="Read" files={files.read} testId="files-read" />
      <p className="m-0 text-small text-text-muted">Derived from Read, Edit, Write and NotebookEdit tool calls.</p>
    </div>
  )
}
