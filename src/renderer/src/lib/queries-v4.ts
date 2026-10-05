import type { QueryClient } from '@tanstack/react-query'
import { qk, useRead, useWrite } from './queries'

/** Hooks for the 0.4 Programs pages: programs, backlog, background engineering, expertise. */

export const qkv4 = {
  programsRoot: () => ['programs'] as const,
  programList: (projectId: string | null) => ['programs', 'list', projectId ?? 'all'] as const,
  program: (programId: string) => ['programs', 'detail', programId] as const,
  presets: () => ['programs', 'presets'] as const,
  backgroundRoot: () => ['background'] as const,
  backgroundSettings: () => ['background', 'settings'] as const,
  backgroundJobs: (projectId: string) => ['background', 'jobs', projectId] as const,
  expertise: (projectId: string) => ['programs', 'expertise', projectId] as const,
}

export const useProgramList = (projectId: string | null = null) =>
  useRead(qkv4.programList(projectId), 'program.list', { ...(projectId ? { projectId } : {}), limit: 100 })

export const useProgram = (programId: string | null) =>
  useRead(qkv4.program(programId ?? ''), 'program.get', { programId: programId ?? '' }, !!programId)

export const useProgramPresets = () => useRead(qkv4.presets(), 'program.presets', {})

export const useExpertise = (projectId: string | null) =>
  useRead(qkv4.expertise(projectId ?? ''), 'expertise.list', { projectId: projectId ?? '' }, !!projectId)

export const useBackgroundSettings = () => useRead(qkv4.backgroundSettings(), 'background.settings', {})

export const useBackgroundJobs = (projectId: string | null) =>
  useRead(qkv4.backgroundJobs(projectId ?? ''), 'background.jobs', { projectId: projectId ?? '' }, !!projectId)

const refreshPrograms = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qkv4.programsRoot() })
  void qc.invalidateQueries({ queryKey: qk.homeRoot() })
  void qc.invalidateQueries({ queryKey: qk.runsRoot() })
}
export const useCreateProgram = () => useWrite('program.create', refreshPrograms)
export const useStartProgram = () => useWrite('program.start', refreshPrograms)
export const usePauseProgram = () => useWrite('program.pause', refreshPrograms)
export const useResumeProgram = () => useWrite('program.resume', refreshPrograms)
export const useCancelProgram = () => useWrite('program.cancel', refreshPrograms)
export const useDecidePlan = () => useWrite('program.decidePlan', refreshPrograms)
export const useReplanProgram = () => useWrite('program.replan', refreshPrograms)
export const useSetBacklogStatus = () => useWrite('backlog.setStatus', refreshPrograms)

export const useSetBackgroundSettings = () =>
  useWrite('background.setSettings', (qc, settings) => {
    qc.setQueryData(qkv4.backgroundSettings(), settings)
    void qc.invalidateQueries({ queryKey: qkv4.backgroundRoot() })
  })
const refreshBackground = (qc: QueryClient) => {
  void qc.invalidateQueries({ queryKey: qkv4.backgroundRoot() })
  void qc.invalidateQueries({ queryKey: qkv4.programsRoot() })
}
export const useStartBackgroundJob = () => useWrite('background.start', refreshBackground)
export const useCancelBackgroundJob = () => useWrite('background.cancel', refreshBackground)
