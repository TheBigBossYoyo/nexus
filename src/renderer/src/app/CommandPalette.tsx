import { useMemo, useRef, useState } from 'react'
import { Command } from 'cmdk'
import {
  useOpenProject,
  useProjects,
  useRefreshAuth,
  useRuns,
  useSettings,
  useUpdateSettings,
} from '../lib/queries'
import { useUiStore, type View } from '../store/ui'
import { Kbd, SearchIcon } from '../components/ui'
import { useModal } from '../components/ui/useModal'
import { useRunControls } from './useRunControls'
import { useCurrentProject, useSelectedRun } from './useCurrent'
import { buildPaletteItems, filterPalette, type PaletteItem } from './paletteModel'

/** Ctrl+K. Arrow keys move, Enter runs, Esc closes; type to search commands, missions, tasks and agents. */
export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen)
  const setOpen = useUiStore((s) => s.setPaletteOpen)
  if (!open) return null
  return <PaletteBody close={() => setOpen(false)} />
}

function PaletteBody({ close }: { close: () => void }) {
  const [search, setSearch] = useState('')
  const ui = useUiStore.getState
  const navCollapsed = useUiStore((s) => s.navCollapsed)
  const project = useCurrentProject()
  const projectsData = useProjects().data
  const runsData = useRuns(project?.id ?? null).data
  const { detail } = useSelectedRun()
  const controls = useRunControls()
  const openProject = useOpenProject()
  const refreshAuth = useRefreshAuth()
  const settings = useSettings().data
  const updateSettings = useUpdateSettings()
  const rootRef = useRef<HTMLDivElement>(null)
  useModal(rootRef, true, close, 'input')

  const items = useMemo(
    () =>
      buildPaletteItems({
        hasProject: !!project,
        canPause: controls.canPause,
        canResume: controls.canResume,
        canApprovePlan: controls.canApprovePlan,
        hasRun: !!controls.run,
        theme: settings?.appearance.theme ?? 'light',
        density: settings?.appearance.density ?? 'compact',
        navCollapsed,
        tasks: (detail?.tasks ?? []).map((t) => ({ id: t.id, title: t.title, key: t.key })),
        agents: (detail?.agents ?? []).map((a) => ({
          id: a.id,
          label: `${a.role.replace('_', ' ')} agent · ${a.id.slice(0, 6)}`,
        })),
        projects: (projectsData ?? []).map((p) => ({ id: p.id, name: p.name })),
        runs: [...(runsData ?? [])]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((r) => ({ id: r.id, prompt: r.prompt, mode: r.mode })),
      }),
    [
      project,
      controls.canPause,
      controls.canResume,
      controls.canApprovePlan,
      controls.run,
      settings,
      navCollapsed,
      detail,
      projectsData,
      runsData,
    ],
  )
  const sections = useMemo(() => filterPalette(items, search), [items, search])

  const perform = (item: PaletteItem) => {
    close()
    const id = item.id
    const [kind, arg] = id.split(/:(.*)/s) as [string, string | undefined]
    const go = (view: View) => ui().setView(view)
    if (kind === 'view' && arg) return go(arg as View)
    if (kind === 'project' && arg) {
      ui().selectProject(arg)
      return go('projects')
    }
    if (kind === 'run' && arg) {
      const r = (runsData ?? []).find((x) => x.id === arg)
      return ui().openRun(arg, r?.projectId)
    }
    if (kind === 'task' && arg) {
      ui().selectTask(arg)
      return go('run')
    }
    if (kind === 'agent' && arg) {
      ui().selectAgent(arg)
      return go('agents')
    }
    switch (id) {
      case 'project.open':
        void openProject
          .mutateAsync({})
          .then((p) => {
            if (p) {
              ui().selectProject(p.id)
              go('projects')
            }
          })
          .catch(() => undefined)
        return
      case 'mission.new':
        ui().setComposerIntent(null)
        return go('projects')
      case 'overnight.start':
        ui().setComposerIntent('overnight')
        return go('projects')
      case 'mission.approve':
        return controls.approvePlan()
      case 'mission.pause':
        return controls.pause()
      case 'mission.resume':
        return controls.resume()
      case 'mission.show':
        return go('run')
      case 'theme.toggle':
        if (settings)
          updateSettings.mutate({
            settings: {
              ...settings,
              appearance: {
                ...settings.appearance,
                theme: settings.appearance.theme === 'dark' ? 'light' : 'dark',
              },
            },
          })
        return
      case 'density.toggle':
        if (settings)
          updateSettings.mutate({
            settings: {
              ...settings,
              appearance: {
                ...settings.appearance,
                density: settings.appearance.density === 'compact' ? 'comfortable' : 'compact',
              },
            },
          })
        return
      case 'nav.toggle':
        return ui().toggleNav()
      case 'auth.refresh':
        return refreshAuth.mutate()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]"
      data-testid="command-palette"
    >
      <div className="scrim anim-fade absolute inset-0" onClick={close} aria-hidden="true" />
      <div ref={rootRef} className="anim-pop relative">
        <Command
          label="Command palette"
          shouldFilter={false}
          loop
          className="flex max-h-[60vh] w-[36rem] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-elevated shadow-elevated"
        >
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
            <SearchIcon size={14} className="shrink-0 text-text-muted" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Search commands, missions, tasks, agents…"
              aria-label="Search commands"
              className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-text-muted"
            />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className="min-h-0 flex-1 overflow-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-text-muted">
              No matching commands
            </Command.Empty>
            {sections.map((s) => (
              <Command.Group
                key={s.group}
                heading={s.group}
                className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-muted"
              >
                {s.items.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={item.id}
                    onSelect={() => perform(item)}
                    className="flex h-8 cursor-pointer items-center justify-between rounded-md px-2.5 text-body data-[selected=true]:bg-accent-subtle data-[selected=true]:text-text-primary"
                  >
                    <span className="truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="ml-3 shrink-0 font-mono text-caption text-text-muted">
                        {item.hint}
                      </span>
                    ) : null}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
