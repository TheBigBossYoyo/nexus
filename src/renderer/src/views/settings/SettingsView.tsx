import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/settings'
import { useSettings, useUpdateSettings } from '../../lib/queries'
import { cn } from '../../lib/cn'
import { applyAppearance } from '../../app/appearance'
import { Button, ErrorNote, Loading } from '../../components/ui'
import { isSameSettings, normalizeSettings, validateSettings } from './settingsForm'
import {
  AdvancedSection,
  AppearanceSection,
  ClaudeSection,
  ExecutionSection,
  GitSection,
  McpSection,
  MemorySection,
  ModelsSection,
  PermissionsSection,
  type SectionProps,
} from './sections'

type SectionId = 'claude' | 'models' | 'execution' | 'git' | 'permissions' | 'memory' | 'mcp' | 'appearance' | 'advanced'

const SECTIONS: { id: SectionId; label: string; render: (p: SectionProps) => ReactNode; prefix: string }[] = [
  { id: 'claude', label: 'Claude', prefix: 'claude', render: (p) => <ClaudeSection {...p} /> },
  { id: 'models', label: 'Models', prefix: 'models', render: (p) => <ModelsSection {...p} /> },
  { id: 'execution', label: 'Execution', prefix: 'execution', render: (p) => <ExecutionSection {...p} /> },
  { id: 'git', label: 'Git', prefix: 'git', render: (p) => <GitSection {...p} /> },
  { id: 'permissions', label: 'Permissions', prefix: 'permissions', render: (p) => <PermissionsSection {...p} /> },
  { id: 'memory', label: 'Memory', prefix: 'memory', render: (p) => <MemorySection {...p} /> },
  { id: 'mcp', label: 'MCP', prefix: 'mcp', render: (p) => <McpSection {...p} /> },
  { id: 'appearance', label: 'Appearance', prefix: 'appearance', render: (p) => <AppearanceSection {...p} /> },
  { id: 'advanced', label: 'Advanced', prefix: 'advanced', render: (p) => <AdvancedSection {...p} /> },
]

export function SettingsView() {
  const query = useSettings()
  const update = useUpdateSettings()
  const [section, setSection] = useState<SectionId>('claude')
  // null means "no unsaved edits": the form shows the saved settings.
  const [draft, setDraft] = useState<Settings | null>(null)

  const saved = query.data
  const current = draft ?? saved ?? null
  const validation = useMemo(() => (current ? validateSettings(current) : null), [current])
  const errors = validation && !validation.ok ? validation.errors : {}
  const dirty = !!saved && !!draft && !isSameSettings(normalizeSettings(draft), saved)

  // Preview appearance live; restore the saved appearance when edits are discarded or the view closes.
  const savedAppearance = saved?.appearance
  const previewAppearance = current?.appearance
  useEffect(() => {
    if (previewAppearance) applyAppearance(previewAppearance)
    return () => {
      if (savedAppearance) applyAppearance(savedAppearance)
    }
  }, [previewAppearance, savedAppearance])

  if (query.isPending) return <Loading label="Loading settings" />
  if (query.isError) return <ErrorNote error={query.error} className="m-4" />
  if (!current || !saved) return null

  const set: SectionProps['set'] = (key, patch) =>
    setDraft((d) => {
      const base = d ?? saved
      return { ...base, [key]: { ...base[key], ...patch } }
    })

  const errorFor = (path: string) => errors[path]
  const hasErrorIn = (prefix: string) => Object.keys(errors).some((k) => k === prefix || k.startsWith(`${prefix}.`))
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const invalidCount = Object.keys(errors).length

  const save = () => {
    if (!validation?.ok) return
    update.mutate({ settings: validation.settings }, { onSuccess: () => setDraft(null) })
  }

  return (
    <div className="flex h-full min-h-0" data-testid="settings-view">
      <nav className="w-44 shrink-0 border-r bg-surface-1 py-2" aria-label="Settings sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            data-testid={`settings-section-${s.id}`}
            aria-current={s.id === section ? 'page' : undefined}
            onClick={() => setSection(s.id)}
            className={cn(
              'flex h-[var(--row-h)] w-full items-center justify-between border-l-2 px-3 text-left',
              s.id === section ? 'border-accent bg-surface-3' : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {s.label}
            {hasErrorIn(s.prefix) ? <span className="size-1.5 rounded-full bg-tone-danger" title="Has errors" /> : null}
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <h1 className="mb-3 mt-0 text-[1.15rem] font-semibold">{active?.label}</h1>
          {active?.render({ draft: current, set, error: errorFor })}
        </div>
        <footer className="flex h-11 shrink-0 items-center justify-end gap-2 border-t bg-surface-1 px-4">
          {invalidCount > 0 ? (
            <span className="mr-auto text-tone-danger" data-testid="settings-invalid">
              {invalidCount} invalid value{invalidCount === 1 ? '' : 's'}
            </span>
          ) : dirty ? (
            <span className="mr-auto text-tone-waiting">Unsaved changes</span>
          ) : null}
          <Button disabled={!draft} onClick={() => setDraft(null)} data-testid="settings-revert">
            Revert
          </Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || !validation?.ok}
            onClick={save}
            data-testid="settings-save"
          >
            Save
          </Button>
        </footer>
      </div>
    </div>
  )
}
