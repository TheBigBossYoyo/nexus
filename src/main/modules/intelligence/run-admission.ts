import type { Run } from '@shared/domain'
import { NexusError } from '@shared/result'
import type { Repositories } from '@main/modules/persistence'

/** Recovery never compiles implicitly or treats a prompt marker as internal-work authority. */
export function assertRunAdmission(repos: Repositories, run: Run): void {
  if (run.mode === 'ask' || run.mode === 'audit') return
  const owner = run.config.engineeringOwner
  const programId = owner?.kind === 'PROGRAM' ? owner.id
    : repos.programMissions.getByRun(run.id)?.programId ?? repos.programs.getByRun(run.id)?.id
  if (programId) {
    const program = repos.programs.require(programId)
    if (program.projectId === run.projectId && repos.intelligenceArtifacts.admission('PROGRAM', programId)?.status === 'READY') return
    throw new NexusError('invalid_state', 'The parent program needs a compiled specification before its work can resume.')
  }
  const task = repos.workspaceTasks.getByRun(run.id)
  const missionId = owner?.kind === 'WORKSPACE_MISSION' ? owner.id : task?.missionId
  if (missionId) {
    const mission = repos.workspaceMissions.require(missionId)
    const enrolled = repos.enrolledRepositories.listByWorkspace(mission.workspaceId)
    const spec = mission.programId ? repos.intelligenceArtifacts.admission('WORKSPACE_PROGRAM', mission.programId)
      : repos.intelligenceArtifacts.admission('WORKSPACE_MISSION', mission.id)
    if (enrolled.some(r => r.projectId === run.projectId) && spec?.status === 'READY') return
    throw new NexusError('invalid_state', 'The parent workspace workload needs a compiled specification before its work can resume.')
  }
  // Arena cases are controlled benchmark inputs, not new user engineering instructions.
  const trialId = run.config.strategy?.arenaTrialId
  if (repos.arenaTrials.getByRun(run.id) || (trialId && repos.arenaTrials.get(trialId))) return
  const snapshot = run.config.compiledTaskSpec
  const canonical = snapshot ? repos.intelligenceArtifacts.compilation(run.projectId, snapshot.id) : null
  if (!canonical || canonical.status !== 'READY' || canonical.rawIntent !== snapshot?.rawIntent)
    throw new NexusError('invalid_state', 'This mission needs a compiled specification before it can resume. Preview its original request first.')
}
