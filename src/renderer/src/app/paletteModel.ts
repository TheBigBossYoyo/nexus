import { NAV_ITEMS } from './nav'

/** Pure model of the command palette: which actions exist for a context, and how a query ranks them. */

export type PaletteGroup =
  'Mission' | 'Project' | 'Go to' | 'Tasks' | 'Agents' | 'Missions' | 'Appearance'

export interface PaletteItem {
  id: string
  label: string
  group: PaletteGroup
  /** Extra words the query also matches. */
  keywords?: string
  /** Right-aligned hint: a shortcut or a short state. */
  hint?: string
}

export interface PaletteContext {
  hasProject: boolean
  canPause: boolean
  canResume: boolean
  canApprovePlan: boolean
  hasRun: boolean
  theme: 'light' | 'dark'
  density: 'compact' | 'comfortable'
  navCollapsed: boolean
  tasks: readonly { id: string; title: string; key: string }[]
  agents: readonly { id: string; label: string }[]
  projects: readonly { id: string; name: string }[]
  runs: readonly { id: string; prompt: string; mode: string }[]
}

const GROUP_ORDER: readonly PaletteGroup[] = [
  'Mission',
  'Project',
  'Go to',
  'Missions',
  'Tasks',
  'Agents',
  'Appearance',
]

/** Every action available in this context. Task, agent and mission entries are included so a query can find them. */
export function buildPaletteItems(ctx: PaletteContext): PaletteItem[] {
  const items: PaletteItem[] = []
  items.push({
    id: 'project.open',
    label: 'Open project…',
    group: 'Project',
    keywords: 'add repository folder git',
  })
  items.push({
    id: 'mission.new',
    label: 'New mission',
    group: 'Mission',
    keywords: 'start create composer prompt',
  })
  items.push({
    id: 'overnight.start',
    label: 'Start Overnight mission',
    group: 'Mission',
    keywords: 'night unattended deadline shutdown',
  })
  if (ctx.canApprovePlan)
    items.push({
      id: 'mission.approve',
      label: 'Approve plan',
      group: 'Mission',
      keywords: 'plan accept',
    })
  if (ctx.canPause)
    items.push({
      id: 'mission.pause',
      label: 'Pause mission',
      group: 'Mission',
      keywords: 'stop hold run',
    })
  if (ctx.canResume)
    items.push({
      id: 'mission.resume',
      label: 'Resume mission',
      group: 'Mission',
      keywords: 'continue run',
    })
  if (ctx.hasRun)
    items.push({
      id: 'mission.show',
      label: 'Show selected mission',
      group: 'Mission',
      keywords: 'current run',
    })
  for (const p of ctx.projects)
    items.push({
      id: `project:${p.id}`,
      label: `Switch to ${p.name}`,
      group: 'Project',
      keywords: 'project switch',
    })

  const OPEN_LABEL: Partial<Record<string, string>> = {
    arena: 'Open Arena',
    usage: 'Open Usage',
    policy: 'Open Policy',
    settings: 'Open settings',
  }
  NAV_ITEMS.forEach((n, i) => {
    const open = OPEN_LABEL[n.view]
    items.push({
      id: `view:${n.view}`,
      label: open ?? `Go to ${n.label}`,
      group: 'Go to',
      keywords: n.keywords,
      ...(i < 9 ? { hint: `Ctrl ${i + 1}` } : {}),
    })
  })
  items.push({
    id: 'view:auth',
    label: 'Go to Authentication',
    group: 'Go to',
    keywords: 'sign in login claude account',
  })

  for (const r of [...ctx.runs].slice(0, 12)) {
    items.push({
      id: `run:${r.id}`,
      label: `Open mission: ${r.prompt.replace(/\s+/g, ' ').slice(0, 80)}`,
      group: 'Missions',
      keywords: r.mode,
      hint: r.mode.toUpperCase(),
    })
  }
  for (const t of ctx.tasks)
    items.push({
      id: `task:${t.id}`,
      label: t.title,
      group: 'Tasks',
      keywords: `task ${t.key}`,
      hint: t.key,
    })
  for (const a of ctx.agents)
    items.push({ id: `agent:${a.id}`, label: a.label, group: 'Agents', keywords: 'agent worker' })

  items.push({
    id: 'theme.toggle',
    label: `Switch to ${ctx.theme === 'dark' ? 'light' : 'dark'} theme`,
    group: 'Appearance',
    keywords: 'dark light theme colour',
  })
  items.push({
    id: 'density.toggle',
    label: `Use ${ctx.density === 'compact' ? 'comfortable' : 'compact'} density`,
    group: 'Appearance',
    keywords: 'compact comfortable spacing rows',
  })
  items.push({
    id: 'nav.toggle',
    label: ctx.navCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
    group: 'Appearance',
    keywords: 'navigation rail',
    hint: 'Ctrl B',
  })
  items.push({
    id: 'auth.refresh',
    label: 'Refresh Claude status',
    group: 'Appearance',
    keywords: 'authentication check usage',
  })
  return items
}

/** Higher is better; 0 means "no match". Every query word must match somewhere. */
export function scoreItem(item: PaletteItem, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 1
  const label = item.label.toLowerCase()
  const hay = `${label} ${item.group.toLowerCase()} ${(item.keywords ?? '').toLowerCase()}`
  let total = 0
  for (const w of words) {
    if (label.startsWith(w)) total += 6
    else if (label.split(/[\s:·/-]+/).some((p) => p.startsWith(w))) total += 4
    else if (label.includes(w)) total += 3
    else if (hay.includes(w)) total += 1
    else return 0
  }
  return total
}

/** Task, agent and mission entries only appear once the user has typed something; otherwise the list stays short. */
const SEARCH_ONLY: readonly PaletteGroup[] = ['Tasks', 'Agents', 'Missions']

export interface PaletteSection {
  group: PaletteGroup
  items: PaletteItem[]
}

export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
  perGroupLimit = 8,
): PaletteSection[] {
  const q = query.trim()
  const sections: PaletteSection[] = []
  for (const group of GROUP_ORDER) {
    if (!q && SEARCH_ONLY.includes(group)) continue
    const scored = items
      .filter((i) => i.group === group)
      .map((item, index) => ({ item, index, score: scoreItem(item, q) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, perGroupLimit)
      .map((s) => s.item)
    if (scored.length > 0) sections.push({ group, items: scored })
  }
  // With a query, the group holding the best match goes first so Enter does what the user typed for.
  if (q && sections.length > 1) {
    const best = (s: PaletteSection) => Math.max(...s.items.map((i) => scoreItem(i, q)))
    sections.sort((a, b) => best(b) - best(a))
  }
  return sections
}
