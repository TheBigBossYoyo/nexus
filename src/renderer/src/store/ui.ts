import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** Ephemeral UI state only. Server data lives in the TanStack Query cache. */
export type View = 'projects' | 'run' | 'agents' | 'memory' | 'settings' | 'auth'
export const VIEWS: readonly View[] = ['projects', 'run', 'agents', 'memory', 'settings', 'auth']

export type Drawer = 'approvals' | null
export type PanelLayout = Record<string, number>

interface UiState {
  view: View
  projectId: string | null
  runId: string | null
  taskId: string | null
  agentId: string | null
  inspectorTab: string
  paletteOpen: boolean
  drawer: Drawer
  /** react-resizable-panels layouts keyed by group id; the only persisted slice. */
  panelLayouts: Record<string, PanelLayout>

  setView: (view: View) => void
  selectProject: (projectId: string | null) => void
  /** Select a run and show it. Optionally also selects its project. */
  openRun: (runId: string, projectId?: string) => void
  selectTask: (taskId: string | null) => void
  selectAgent: (agentId: string | null) => void
  setInspectorTab: (tab: string) => void
  setPaletteOpen: (open: boolean) => void
  setDrawer: (drawer: Drawer) => void
  setPanelLayout: (groupId: string, layout: PanelLayout) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: 'projects',
      projectId: null,
      runId: null,
      taskId: null,
      agentId: null,
      inspectorTab: 'overview',
      paletteOpen: false,
      drawer: null,
      panelLayouts: {},

      setView: (view) => set({ view }),
      selectProject: (projectId) => set({ projectId }),
      openRun: (runId, projectId) =>
        set((s) => ({
          view: 'run',
          runId,
          projectId: projectId ?? s.projectId,
          taskId: null,
          agentId: null,
        })),
      selectTask: (taskId) => set({ taskId }),
      selectAgent: (agentId) => set({ agentId }),
      setInspectorTab: (inspectorTab) => set({ inspectorTab }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      setDrawer: (drawer) => set({ drawer }),
      setPanelLayout: (groupId, layout) =>
        set((s) => ({ panelLayouts: { ...s.panelLayouts, [groupId]: layout } })),
    }),
    {
      name: 'nexus.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ panelLayouts: s.panelLayouts }),
    },
  ),
)
