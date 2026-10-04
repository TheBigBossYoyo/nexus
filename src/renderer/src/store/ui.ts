import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { VIEWS, type View } from './views'

export { VIEWS }
export type { View }

/** Ephemeral UI state only. Server data lives in the TanStack Query cache. */
/** Pre-selects the mission composer when it opens (set by "Start Overnight" in the palette and the Overnight page). */
export type ComposerIntent = 'overnight' | null

/** Section of the Settings page to open (e.g. the Usage behavior section from the quota banner). */
export type SettingsSection = string | null

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
  /** Left navigation is collapsed to an icon rail. Persisted locally. */
  navCollapsed: boolean
  composerIntent: ComposerIntent
  settingsSection: SettingsSection

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
  setNavCollapsed: (collapsed: boolean) => void
  toggleNav: () => void
  setComposerIntent: (intent: ComposerIntent) => void
  /** Show the Settings page on a given section. */
  openSettings: (section?: string) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      view: 'home',
      projectId: null,
      runId: null,
      taskId: null,
      agentId: null,
      inspectorTab: 'overview',
      paletteOpen: false,
      drawer: null,
      panelLayouts: {},
      navCollapsed: false,
      composerIntent: null,
      settingsSection: null,

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
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
      setComposerIntent: (composerIntent) => set({ composerIntent }),
      openSettings: (section) => set({ view: 'settings', settingsSection: section ?? null }),
    }),
    {
      name: 'nexus.ui',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ panelLayouts: s.panelLayouts, navCollapsed: s.navCollapsed }),
    },
  ),
)
