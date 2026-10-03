import type { Project } from '@shared/domain'
import { nowIso } from '@shared/ids'
import { errorMessage } from '@shared/result'
import { refreshIntelligence } from '@main/modules/intelligence'
import type { OrchestratorDeps } from './deps'

/**
 * Re-analyze a project's repository and reconcile its stored facts. Returns null when the analysis
 * failed: callers carry on without fresh facts (opening a project and starting a run never depend on it).
 */
export async function refreshProjectFacts(
  deps: Pick<OrchestratorDeps, 'repos' | 'git'>,
  project: Project,
  log?: (line: string) => void,
): Promise<{ facts: number; stale: number } | null> {
  try {
    const result = await refreshIntelligence({
      projectId: project.id,
      rootPath: project.rootPath,
      profile: project.profile,
      git: deps.git,
      now: nowIso(),
      store: deps.repos.facts,
    })
    return { facts: result.facts, stale: result.stale }
  } catch (e) {
    log?.(`repository intelligence refresh failed for ${project.name}: ${errorMessage(e)}`)
    return null
  }
}
