import type { Project } from '@shared/domain'
import { useProjects, useRunDetail } from '../lib/queries'
import { useUiStore } from '../store/ui'

/** The selected project, falling back to the first one so a fresh install is never "no project" with projects present. */
export function useCurrentProject(): Project | null {
  const projectId = useUiStore((s) => s.projectId)
  const projects = useProjects().data
  if (!projects) return null
  return projects.find((p) => p.id === projectId) ?? projects[0] ?? null
}

export function useSelectedRun() {
  const runId = useUiStore((s) => s.runId)
  const query = useRunDetail(runId)
  return { runId, detail: query.data ?? null, query }
}
