import type { View } from '../store/views'

export type NavGroupId = 'workspace' | 'intelligence' | 'system'

export interface NavItem {
  view: View
  label: string
  group: NavGroupId
  /** Words the command palette also matches. */
  keywords: string
}

/** Navigation order. Ctrl+1..9 map to the first nine entries in this order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { view: 'home', label: 'Home', group: 'workspace', keywords: 'overview dashboard start' },
  {
    view: 'projects',
    label: 'Projects',
    group: 'workspace',
    keywords: 'repository repo open mission composer',
  },
  { view: 'run', label: 'Missions', group: 'workspace', keywords: 'runs run plan graph tasks' },
  { view: 'agents', label: 'Agents', group: 'workspace', keywords: 'workers output tools' },
  {
    view: 'arena',
    label: 'Arena',
    group: 'intelligence',
    keywords: 'strategies campaigns compare benchmark',
  },
  {
    view: 'policy',
    label: 'Policy',
    group: 'intelligence',
    keywords: 'adaptive strategy preferences',
  },
  {
    view: 'usage',
    label: 'Usage',
    group: 'intelligence',
    keywords: 'claude tokens limit quota subscription',
  },
  {
    view: 'performance',
    label: 'Performance',
    group: 'intelligence',
    keywords: 'metrics outcomes success',
  },
  {
    view: 'intelligence',
    label: 'Repository',
    group: 'intelligence',
    keywords: 'repository intelligence facts files',
  },
  {
    view: 'overnight',
    label: 'Overnight',
    group: 'system',
    keywords: 'night unattended shutdown deadline',
  },
  { view: 'activity', label: 'Activity', group: 'system', keywords: 'events feed log history' },
  { view: 'memory', label: 'Memory', group: 'system', keywords: 'notes knowledge decisions' },
  {
    view: 'settings',
    label: 'Settings',
    group: 'system',
    keywords: 'preferences configuration appearance',
  },
]

export const NAV_GROUPS: readonly { id: NavGroupId; label: string }[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'system', label: 'System' },
]

export const NUMBERED_VIEWS: readonly View[] = NAV_ITEMS.slice(0, 9).map((n) => n.view)

/** Page title and breadcrumb context per view. */
export const VIEW_META: Record<View, { title: string; context?: string }> = {
  home: { title: 'Home' },
  projects: { title: 'Projects', context: 'Workspace' },
  run: { title: 'Missions', context: 'Workspace' },
  agents: { title: 'Agents', context: 'Workspace' },
  arena: { title: 'Arena', context: 'Intelligence' },
  policy: { title: 'Policy', context: 'Intelligence' },
  usage: { title: 'Usage', context: 'Intelligence' },
  performance: { title: 'Performance', context: 'Intelligence' },
  intelligence: { title: 'Repository', context: 'Intelligence' },
  overnight: { title: 'Overnight', context: 'System' },
  activity: { title: 'Activity', context: 'System' },
  memory: { title: 'Memory', context: 'System' },
  settings: { title: 'Settings', context: 'System' },
  auth: { title: 'Authentication', context: 'System' },
}

/** Views that render their own PageHeader. The shell adds a default one for every other view. */
export const VIEWS_WITH_OWN_HEADER: readonly View[] = [
  'home',
  'projects',
  'arena',
  'policy',
  'usage',
  'overnight',
  'activity',
  'settings',
  'agents',
  'memory',
  'performance',
  'intelligence',
  'auth',
  'run',
]
