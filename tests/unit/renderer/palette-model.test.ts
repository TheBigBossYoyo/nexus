import { describe, expect, it } from 'vitest'
import {
  buildPaletteItems,
  filterPalette,
  scoreItem,
  type PaletteContext,
} from '../../../src/renderer/src/app/paletteModel'
import { hotkeyAction } from '../../../src/renderer/src/app/hotkeysModel'
import { NAV_ITEMS, NUMBERED_VIEWS } from '../../../src/renderer/src/app/nav'

const ctx = (patch: Partial<PaletteContext> = {}): PaletteContext => ({
  hasProject: true,
  canPause: false,
  canResume: false,
  canApprovePlan: false,
  hasRun: false,
  theme: 'light',
  density: 'compact',
  navCollapsed: false,
  tasks: [],
  agents: [],
  projects: [],
  runs: [],
  ...patch,
})
const ids = (c: PaletteContext) => buildPaletteItems(c).map((i) => i.id)

describe('palette items', () => {
  it('always offers navigation to every view and the core actions', () => {
    const all = ids(ctx())
    for (const n of NAV_ITEMS) expect(all).toContain(`view:${n.view}`)
    expect(all).toEqual(
      expect.arrayContaining([
        'project.open',
        'mission.new',
        'overnight.start',
        'theme.toggle',
        'density.toggle',
        'nav.toggle',
        'view:auth',
      ]),
    )
  })

  it('offers pause or resume only when the selected mission allows it', () => {
    expect(ids(ctx())).not.toContain('mission.pause')
    expect(ids(ctx({ canPause: true }))).toContain('mission.pause')
    expect(ids(ctx({ canPause: true }))).not.toContain('mission.resume')
    expect(ids(ctx({ canResume: true }))).toContain('mission.resume')
  })

  it('labels the toggles for the opposite state', () => {
    const labels = (c: PaletteContext) => buildPaletteItems(c).map((i) => i.label)
    expect(labels(ctx({ theme: 'light' }))).toContain('Switch to dark theme')
    expect(labels(ctx({ theme: 'dark', density: 'comfortable', navCollapsed: true }))).toEqual(
      expect.arrayContaining(['Switch to light theme', 'Use compact density', 'Expand sidebar']),
    )
  })

  it('names Open Arena, Open Usage, Open Policy and Open settings', () => {
    const labels = buildPaletteItems(ctx()).map((i) => i.label)
    expect(labels).toEqual(
      expect.arrayContaining(['Open Arena', 'Open Usage', 'Open Policy', 'Open settings']),
    )
  })
})

describe('palette filtering', () => {
  const full = buildPaletteItems(
    ctx({
      tasks: [{ id: 't1', title: 'Fix the login redirect', key: 'api-fix' }],
      agents: [{ id: 'a1', label: 'worker agent · a1b2c3' }],
      runs: [{ id: 'r1', prompt: 'Refactor the billing module', mode: 'mission' }],
    }),
  )

  it('keeps task, agent and mission entries out of the empty-query list', () => {
    const groups = filterPalette(full, '').map((s) => s.group)
    expect(groups).not.toContain('Tasks')
    expect(groups).not.toContain('Agents')
    expect(groups).not.toContain('Missions')
  })

  it('finds tasks, agents and missions by typing', () => {
    const find = (q: string) =>
      filterPalette(full, q)
        .flatMap((s) => s.items)
        .map((i) => i.id)
    expect(find('login')).toContain('task:t1')
    expect(find('worker')).toContain('agent:a1')
    expect(find('billing')).toContain('run:r1')
  })

  it('requires every word to match and ranks label prefixes first', () => {
    const hits = filterPalette(full, 'open ar').flatMap((s) => s.items)
    expect(hits[0]?.id).toBe('view:arena')
    expect(filterPalette(full, 'zzzz')).toEqual([])
    const usage = full.find((i) => i.id === 'view:usage')
    expect(usage).toBeDefined()
    if (usage) {
      expect(scoreItem(usage, 'open usage')).toBeGreaterThan(scoreItem(usage, 'quota'))
      expect(scoreItem(usage, 'banana')).toBe(0)
    }
  })

  it('puts the group with the best match first when searching', () => {
    expect(filterPalette(full, 'refactor')[0]?.group).toBe('Missions')
  })
})

describe('hotkeys', () => {
  const key = (k: string, extra: object = {}) => ({
    key: k,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  })

  it('maps Ctrl+K, Ctrl+B, Ctrl+1..9 and Esc', () => {
    expect(hotkeyAction(key('k'))).toEqual({ type: 'palette' })
    expect(hotkeyAction(key('K'))).toEqual({ type: 'palette' })
    expect(hotkeyAction(key('b'))).toEqual({ type: 'nav' })
    expect(hotkeyAction(key('1'))).toEqual({ type: 'view', view: 'home' })
    expect(hotkeyAction(key('9'))).toEqual({ type: 'view', view: NUMBERED_VIEWS[8] })
    expect(hotkeyAction({ ...key('Escape'), ctrlKey: false })).toEqual({ type: 'escape' })
  })

  it('ignores plain keys, other modifiers and numbers past nine', () => {
    expect(hotkeyAction(key('k', { ctrlKey: false }))).toBeNull()
    expect(hotkeyAction(key('k', { shiftKey: true }))).toBeNull()
    expect(hotkeyAction(key('k', { altKey: true }))).toBeNull()
    expect(hotkeyAction(key('0'))).toBeNull()
    expect(NUMBERED_VIEWS).toHaveLength(9)
  })
})
