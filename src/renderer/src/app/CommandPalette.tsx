import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useOpenProject, useProjects, useRefreshAuth, useRuns, useSettings, useUpdateSettings } from '../lib/queries'
import { useUiStore, type View } from '../store/ui'
import { useRunControls } from './useRunControls'
import { useCurrentProject } from './useCurrent'

const VIEW_ITEMS: { view: View; label: string; keys: string }[] = [
  { view: 'projects', label: 'Go to Projects', keys: 'Ctrl 1' },
  { view: 'run', label: 'Go to Runs', keys: 'Ctrl 2' },
  { view: 'agents', label: 'Go to Agents', keys: 'Ctrl 3' },
  { view: 'memory', label: 'Go to Memory', keys: 'Ctrl 4' },
  { view: 'settings', label: 'Go to Settings', keys: 'Ctrl 5' },
  { view: 'auth', label: 'Go to Authentication', keys: '' },
]

function Item({ label, hint, onSelect, value }: { label: string; hint?: string; onSelect: () => void; value?: string }) {
  return (
    <Command.Item
      value={value ?? label}
      onSelect={onSelect}
      className="flex h-[var(--row-h)] cursor-pointer items-center justify-between px-3 data-[selected=true]:bg-surface-3"
    >
      <span className="truncate">{label}</span>
      {hint ? <span className="ml-3 shrink-0 font-mono text-[0.8rem] text-fg-faint">{hint}</span> : null}
    </Command.Item>
  )
}

const GROUP =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[0.75rem] ' +
  '[&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider ' +
  '[&_[cmdk-group-heading]]:text-fg-faint'

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen)
  const setOpen = useUiStore((s) => s.setPaletteOpen)
  if (!open) return null
  return <PaletteBody close={() => setOpen(false)} />
}

function PaletteBody({ close }: { close: () => void }) {
  const [search, setSearch] = useState('')
  const setView = useUiStore((s) => s.setView)
  const selectProject = useUiStore((s) => s.selectProject)
  const openRun = useUiStore((s) => s.openRun)
  const project = useCurrentProject()
  const projects = useProjects().data ?? []
  const runs = useRuns(project?.id ?? null).data ?? []
  const controls = useRunControls()
  const openProject = useOpenProject()
  const refreshAuth = useRefreshAuth()
  const settings = useSettings().data
  const updateSettings = useUpdateSettings()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const run = (fn: () => void) => () => {
    close()
    fn()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[14vh]" data-testid="command-palette">
      <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden="true" />
      <Command
        label="Command palette"
        className="relative flex max-h-[60vh] w-[34rem] max-w-[94vw] flex-col border border-border-strong bg-surface-1 shadow-xl"
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder="Type a command or search…"
          className="h-9 shrink-0 border-b bg-transparent px-3 outline-none placeholder:text-fg-faint"
        />
        <Command.List className="min-h-0 flex-1 overflow-auto py-1">
          <Command.Empty className="px-3 py-4 text-center text-fg-muted">No matching commands</Command.Empty>

          <Command.Group heading="Navigate" className={GROUP}>
            {VIEW_ITEMS.map((v) => (
              <Item key={v.view} label={v.label} hint={v.keys} onSelect={run(() => setView(v.view))} />
            ))}
          </Command.Group>

          {controls.run ? (
            <Command.Group heading="Selected run" className={GROUP}>
              {controls.canApprovePlan ? <Item label="Approve plan" onSelect={run(controls.approvePlan)} /> : null}
              {controls.canPause ? <Item label="Pause run" onSelect={run(controls.pause)} /> : null}
              {controls.canResume ? <Item label="Resume run" onSelect={run(controls.resume)} /> : null}
              <Item label="Show selected run" onSelect={run(() => setView('run'))} />
            </Command.Group>
          ) : null}

          <Command.Group heading="Projects" className={GROUP}>
            <Item
              label="Open project…"
              onSelect={run(() => {
                void openProject
                  .mutateAsync({})
                  .then((p) => {
                    if (p) {
                      selectProject(p.id)
                      setView('projects')
                    }
                  })
                  .catch(() => undefined)
              })}
            />
            {projects.map((p) => (
              <Item
                key={p.id}
                value={`Switch to project ${p.name} ${p.id}`}
                label={`Switch to project: ${p.name}`}
                onSelect={run(() => {
                  selectProject(p.id)
                  setView('projects')
                })}
              />
            ))}
          </Command.Group>

          {runs.length > 0 ? (
            <Command.Group heading="Runs" className={GROUP}>
              {[...runs]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 10)
                .map((r) => (
                  <Item
                    key={r.id}
                    value={`Open run ${r.mode} ${r.prompt} ${r.id}`}
                    label={`Open run: ${r.prompt}`}
                    hint={r.mode.toUpperCase()}
                    onSelect={run(() => openRun(r.id, r.projectId))}
                  />
                ))}
            </Command.Group>
          ) : null}

          <Command.Group heading="System" className={GROUP}>
            <Item label="Refresh authentication status" onSelect={run(() => refreshAuth.mutate())} />
            {settings ? (
              <Item
                label={`Switch to ${settings.appearance.theme === 'dark' ? 'light' : 'dark'} theme`}
                onSelect={run(() =>
                  updateSettings.mutate({
                    settings: {
                      ...settings,
                      appearance: { ...settings.appearance, theme: settings.appearance.theme === 'dark' ? 'light' : 'dark' },
                    },
                  }),
                )}
              />
            ) : null}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  )
}
